/**
 * CI <-> `check:all` parity drift detector.
 *
 * Parses every gate workflow under `.github/workflows` (basename starting
 * with `ciParity.workflowPrefix`) and fails when a gate-script invocation
 * in a CI `run:` step is not transitively reachable from the gate
 * manifest — i.e. when CI enforces something `check:all` does not exercise
 * locally.
 *
 * Per-repo escape hatches live in `ciParity.configPath`:
 *
 *   { "aliases": { "check:coverage:ci": "check:coverage" },
 *     "ciOnly": ["test:e2e"] }
 *
 *   - `aliases` maps a CI-side script name onto a gate-reachable
 *     equivalent (same gate, different reporter/preamble).
 *   - `ciOnly` allowlists scripts that are intentionally CI-only (heavy
 *     e2e / setup / summaries with no local equivalent).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import type { Ctx } from "./config.ts";
import { gatesForRepo } from "./check-all.ts";
import { loadScripts } from "./lib/pkg.ts";

export type ParityConfig = { aliases: Record<string, string>; ciOnly: ReadonlySet<string> };

type RawParityConfig = { aliases?: Record<string, string>; ciOnly?: string[] };

export function loadParityConfig(configPath: string): ParityConfig {
  if (!existsSync(configPath)) return { aliases: {}, ciOnly: new Set() };
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as RawParityConfig;
  return { aliases: raw.aliases ?? {}, ciOnly: new Set(raw.ciOnly ?? []) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the matcher for the configured runner, e.g. runner "pnpm run"
 *  matches `pnpm run <name>` and captures `<name>`. A bare invocation
 *  without the runner keyword (e.g. `pnpm install`) is intentionally not
 *  matched. */
export function makeRunTargetRe(runner: string): RegExp {
  return new RegExp(`${escapeRegExp(runner)}\\s+([A-Za-z][\\w:-]*)(?![\\w./:-])`, "g");
}

export function extractRunTargets(command: string, runner: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(makeRunTargetRe(runner))) {
    const name = match[1];
    if (name) out.push(name);
  }
  return out;
}

/**
 * Everything reachable from the gate manifest: the manifest itself, the
 * configured entry points (check:all / verify), and the transitive
 * closure of runner references in script bodies.
 */
export function computeReachable(
  scripts: Record<string, string>,
  gates: readonly string[],
  entryGates: readonly string[],
  runner: string,
): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [...entryGates, ...gates];
  while (stack.length > 0) {
    const name = stack.pop();
    if (!name || reachable.has(name)) continue;
    reachable.add(name);
    const body = scripts[name];
    if (body === undefined) continue;
    for (const dep of extractRunTargets(body, runner)) {
      if (!reachable.has(dep)) stack.push(dep);
    }
  }
  return reachable;
}

type WorkflowStep = { run?: unknown };
type WorkflowJob = { steps?: WorkflowStep[] };
type WorkflowFile = { jobs?: Record<string, WorkflowJob> };

export type CiInvocation = { workflow: string; job: string; step: number; script: string };

export function extractCiInvocations(
  filePath: string,
  repoRoot: string,
  runner: string,
): CiInvocation[] {
  const text = readFileSync(filePath, "utf8");
  const doc = parse(text) as WorkflowFile | null;
  const workflow = relative(repoRoot, filePath);
  const out: CiInvocation[] = [];
  if (!doc || typeof doc !== "object" || !doc.jobs) return out;
  for (const [jobName, job] of Object.entries(doc.jobs)) {
    const steps = job?.steps;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, idx) => {
      const run = step?.run;
      if (typeof run !== "string") return;
      for (const script of extractRunTargets(run, runner)) {
        out.push({ workflow, job: jobName, step: idx, script });
      }
    });
  }
  return out;
}

/** Gate workflows only — release/deploy orchestration is intentionally
 *  out-of-band from the per-PR gate. */
export function listCiWorkflows(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && f.startsWith(prefix))
    .map((f) => join(dir, f))
    .sort();
}

export type ParityFailure = CiInvocation & { canonical: string; reason: string };

export function evaluateParity(
  invocations: CiInvocation[],
  reachable: ReadonlySet<string>,
  config: ParityConfig,
  rootGate: string,
): ParityFailure[] {
  const failures: ParityFailure[] = [];
  for (const inv of invocations) {
    const canonical = config.aliases[inv.script] ?? inv.script;
    if (config.ciOnly.has(canonical)) continue;
    if (reachable.has(canonical)) continue;
    const reason =
      canonical === inv.script
        ? `not reachable from ${rootGate}`
        : `aliased to "${canonical}", which is not reachable from ${rootGate}`;
    failures.push({ ...inv, canonical, reason });
  }
  return failures;
}

export function checkParity(ctx: Ctx): {
  invocations: CiInvocation[];
  reachable: Set<string>;
  failures: ParityFailure[];
} {
  const { runner, ciParity } = ctx.config;
  const reachable = computeReachable(
    loadScripts(ctx.repoRoot),
    gatesForRepo(ctx),
    ciParity.entryGates,
    runner,
  );
  const workflowsDir = resolve(ctx.repoRoot, ".github/workflows");
  const invocations: CiInvocation[] = [];
  for (const wf of listCiWorkflows(workflowsDir, ciParity.workflowPrefix)) {
    invocations.push(...extractCiInvocations(wf, ctx.repoRoot, runner));
  }
  const config = loadParityConfig(resolve(ctx.repoRoot, ciParity.configPath));
  const failures = evaluateParity(invocations, reachable, config, ciParity.rootGate);
  return { invocations, reachable, failures };
}

function formatFailure(f: ParityFailure): string {
  return `  ${f.workflow} (job=${f.job}, step=${f.step}): ${f.script} — ${f.reason}`;
}

/** Run the parity check. Returns the process exit code. */
export function runCiParity(ctx: Ctx): number {
  const { rootGate, configPath } = ctx.config.ciParity;
  const { invocations, reachable, failures } = checkParity(ctx);
  if (failures.length === 0) {
    console.log(
      `✓ CI parity: ${invocations.length} gate invocation(s) across CI workflows, ` +
        `all reachable from "${rootGate}" (${reachable.size} scripts in graph).`,
    );
    return 0;
  }
  console.error(
    `✗ CI parity drift: ${failures.length} CI step(s) invoke a script not ` +
      `reachable from "${rootGate}":\n`,
  );
  for (const f of failures) console.error(formatFailure(f));
  console.error(
    `\nFix one of:\n` +
      `  - Wire the script into the gate manifest / a gate's script body.\n` +
      `  - Change CI to invoke a script that is already reachable.\n` +
      `  - If the step is intentionally CI-only, add it to "ciOnly" in ${configPath}.\n` +
      `  - If two scripts run the same gate under different names, map the CI name\n` +
      `    to its canonical equivalent in "aliases" in ${configPath}.`,
  );
  return 1;
}
