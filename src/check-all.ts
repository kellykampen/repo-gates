/**
 * Quiet, manifest-driven gate runner (the `check:all` engine).
 *
 * Resolves its gate manifest from the consumer's {@link RepoGatesConfig}
 * filtered against the repo's package.json: required gates in the selected
 * manifest are mandatory (a missing one fails the run); conditional gates run
 * only when defined. A consumer may deliberately replace the default manifest
 * — for example, with a coverage-backed test gate instead of a plain test run.
 *
 * Output contract ("quiet"):
 *   - one aligned `<status> <gate> (N.Ns)` line per gate
 *   - a one-line tally on success
 *   - on failure: the failing gate names plus parsed failure signatures
 *     from the captured output — never the full log
 *   - opts.verbose streams every gate's full output instead
 *   - opts.bail stops at the first failing gate
 */

import { spawnSync } from "node:child_process";
import type { Ctx, GateSpec } from "./config.ts";
import { loadScripts } from "./lib/pkg.ts";

/**
 * Resolve the manifest: every required gate (whether or not the repo defines
 * it — a missing required gate must fail loudly, not silently narrow the
 * manifest) plus each conditional gate the repo's package.json defines.
 */
export function resolveGates(
  scripts: Record<string, string>,
  gates: readonly GateSpec[],
): string[] {
  return gates.filter((g) => !g.conditional || scripts[g.name] !== undefined).map((g) => g.name);
}

/** The resolved manifest for a repo — the single source of truth that the
 *  CI-parity gate consumes. */
export function gatesForRepo(ctx: Ctx): string[] {
  return resolveGates(loadScripts(ctx.repoRoot), ctx.config.gates);
}

export function formatGateLine(
  status: "ok" | "fail",
  gate: string,
  seconds: number,
  width: number,
): string {
  const mark = status === "ok" ? "✓" : "✗";
  return `${mark} ${gate.padEnd(width)} (${seconds.toFixed(1)}s)`;
}

const SIGNATURE_RE =
  /error TS\d+|: error |^error:|^✗ |^✖|^× |^FAIL\b|^Error: |\bAssertionError\b|\bbelow floor\b|\berror\b.*\bbudget\b|exceeds? .*budget|\[error\]|Code style issues/i;
const MAX_SIGNATURE_LINES = 50;
const TAIL_FALLBACK_LINES = 25;

/**
 * Pull the failure-relevant lines out of a gate's captured output: known
 * failure signatures (tsc/eslint/vitest errors, prettier style
 * complaints, budget-ratchet violations) when present, otherwise the tail
 * of the output.
 */
export function extractFailureSignatures(output: string): string[] {
  const lines = output.split("\n");
  const matched = lines.filter((l) => SIGNATURE_RE.test(l.trim()));
  if (matched.length > 0) return matched.slice(0, MAX_SIGNATURE_LINES);
  return lines.filter((l) => l.trim() !== "").slice(-TAIL_FALLBACK_LINES);
}

const SCORE_PREFIX = "SCORE:";

/**
 * Ratchet gates announce a one-line headline metric by printing a
 * `SCORE: <text>` line; this pulls those out of a gate's captured output so
 * the success summary can show them (binary gates emit nothing). Quiet mode
 * only — verbose streams the gate output directly.
 */
export function extractScores(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(SCORE_PREFIX))
    .map((l) => l.slice(SCORE_PREFIX.length).trim())
    .filter((l) => l.length > 0);
}

/** Render the success `Scores:` block from collected score strings of the
 *  form `<label> — <value>`, aligned by label. Empty input → no block. */
export function formatScoresBlock(scores: string[]): string[] {
  if (scores.length === 0) return [];
  const width = Math.max(...scores.map((s) => s.split("—")[0]?.trim().length ?? 0));
  const out = ["", "Scores:"];
  for (const s of scores) {
    const [label, ...rest] = s.split("—");
    out.push(
      rest.length > 0 && label
        ? `  ${label.trim().padEnd(width)}  ${rest.join("—").trim()}`
        : `  ${s}`,
    );
  }
  return out;
}

export type GateResult = { gate: string; ok: boolean; seconds: number; output: string };

function runGate(gate: string, ctx: Ctx, verbose: boolean): GateResult {
  const [cmd, ...runnerArgs] = ctx.config.runner.split(/\s+/);
  const start = performance.now();
  const proc = spawnSync(cmd ?? "pnpm", [...runnerArgs, gate], {
    cwd: ctx.repoRoot,
    stdio: verbose ? "inherit" : "pipe",
    encoding: "utf8",
    env: process.env,
  });
  const seconds = (performance.now() - start) / 1000;
  const errNote = proc.error ? `\nspawn error: ${proc.error.message}` : "";
  const output = verbose ? errNote.trim() : `${proc.stdout ?? ""}\n${proc.stderr ?? ""}${errNote}`;
  return { gate, ok: proc.status === 0 && !proc.error, seconds, output };
}

export type CheckAllOptions = { verbose?: boolean; bail?: boolean };

/** Run every gate in the manifest. Returns the process exit code. */
export function runCheckAll(ctx: Ctx, opts: CheckAllOptions = {}): number {
  const verbose = opts.verbose ?? false;
  const gates = gatesForRepo(ctx);
  if (gates.length === 0) {
    console.error("check:all — no gates resolved; check repo-gates.config.json");
    return 1;
  }
  const width = Math.max(...gates.map((g) => g.length));
  const results: GateResult[] = [];
  const overallStart = performance.now();

  for (const gate of gates) {
    if (verbose) console.log(`\n── ${gate} ──`);
    const result = runGate(gate, ctx, verbose);
    results.push(result);
    console.log(formatGateLine(result.ok ? "ok" : "fail", gate, result.seconds, width));
    if (!result.ok && opts.bail) break;
  }

  const failures = results.filter((r) => !r.ok);
  const totalSeconds = (performance.now() - overallStart) / 1000;

  if (failures.length === 0) {
    console.log(`\n${results.length}/${gates.length} gates passed (${totalSeconds.toFixed(1)}s)`);
    const scores = results.flatMap((r) => extractScores(r.output));
    for (const line of formatScoresBlock(scores)) console.log(line);
    return 0;
  }

  const runner = ctx.config.runner;
  console.error(`\n${failures.length} gate(s) failed: ${failures.map((f) => f.gate).join(", ")}\n`);
  for (const f of failures) {
    console.error(`── ${f.gate} ──`);
    for (const line of extractFailureSignatures(f.output)) console.error(`  ${line}`);
    console.error(`  ↳ re-run: ${runner} ${f.gate}  (or CHECK_ALL_VERBOSE=1 ${runner} check:all)`);
  }
  return 1;
}
