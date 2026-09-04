/**
 * Coverage guard (ratchet) for a vitest monorepo — PER-PACKAGE floors.
 *
 * Runs the repo's `test:coverage` script (each package emits its own
 * `coverage/coverage-summary.json` via vitest's json-summary reporter),
 * then holds EACH package to its own floor. A single repo-wide aggregate
 * is deliberately avoided: line-weighting lets big well-covered packages
 * mask regressions in smaller ones, and one floor forces a false uniform
 * standard on packages with very different achievable coverage.
 *
 * Floors live in config.coverage.budgetsPath as
 *   { "default": {functions,lines}, "packages": { "<dir>": {functions,lines} } }
 * where `<dir>` is the repo-relative package directory (e.g. "apps/web").
 * A package with no explicit entry must meet `default`. Floors only
 * ratchet UP. `--init` seeds every package's floor just below its current
 * number (keeping the existing `default`, or 80/80 on first seed).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Ctx } from "./config.ts";

export type Floor = { functions: number; lines: number };
export type Budgets = { default: Floor; packages: Record<string, Floor> };
export type Counts = { covered: number; total: number };
export type PkgCoverage = { pkg: string; totals: Floor };
export type PkgFailure = {
  pkg: string;
  metric: "functions" | "lines";
  actual: number;
  floor: number;
  isNew: boolean;
};

export const DEFAULT_MIN: Floor = { functions: 80, lines: 80 };

function validFloor(value: unknown, source: string, where: string): Floor {
  const v = value as Record<string, unknown> | null;
  const out: Floor = { functions: 0, lines: 0 };
  for (const metric of ["functions", "lines"] as const) {
    const n = v?.[metric];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`${source}: ${where}.${metric} must be a percentage in [0, 100]`);
    }
    out[metric] = n;
  }
  return out;
}

export function loadBudgets(raw: string, source = "coverage-budgets"): Budgets {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const def =
    parsed.default === undefined ? DEFAULT_MIN : validFloor(parsed.default, source, "default");
  const pkgsRaw = parsed.packages;
  if (
    pkgsRaw !== undefined &&
    (pkgsRaw === null || typeof pkgsRaw !== "object" || Array.isArray(pkgsRaw))
  ) {
    throw new Error(`${source}: "packages" must be an object`);
  }
  const packages: Record<string, Floor> = {};
  for (const [pkg, floor] of Object.entries((pkgsRaw as Record<string, unknown>) ?? {})) {
    packages[pkg] = validFloor(floor, source, `packages["${pkg}"]`);
  }
  return { default: def, packages };
}

/** Expand a repo-relative glob whose only wildcard is `*` matching a
 *  single path segment (e.g. `packages/*​/coverage/coverage-summary.json`). */
export function expandGlob(repoRoot: string, glob: string): string[] {
  const segments = glob.split("/");
  let dirs = [repoRoot];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    const isLast = i === segments.length - 1;
    const next: string[] = [];
    for (const dir of dirs) {
      if (seg === "*") {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) next.push(full);
        }
      } else {
        const full = join(dir, seg);
        if (isLast ? existsSync(full) : existsSync(full) && statSync(full).isDirectory()) {
          next.push(full);
        }
      }
    }
    dirs = next;
  }
  return dirs;
}

type SummaryMetric = { covered?: unknown; total?: unknown };
type SummaryFile = { total?: { functions?: SummaryMetric; lines?: SummaryMetric } };

export function readSummaryCounts(path: string): { functions: Counts; lines: Counts } | undefined {
  const doc = JSON.parse(readFileSync(path, "utf8")) as SummaryFile;
  const total = doc.total;
  if (!total) return undefined;
  const pick = (m: SummaryMetric | undefined): Counts | undefined => {
    const covered = m?.covered;
    const total_ = m?.total;
    if (typeof covered !== "number" || typeof total_ !== "number") return undefined;
    return { covered, total: total_ };
  };
  const functions = pick(total.functions);
  const lines = pick(total.lines);
  if (!functions || !lines) return undefined;
  return { functions, lines };
}

export function pct(counts: Counts): number {
  return counts.total === 0 ? 100 : (counts.covered / counts.total) * 100;
}

/** The package directory a coverage summary belongs to, e.g.
 *  `apps/web/coverage/coverage-summary.json` → `apps/web`. */
export function pkgKey(repoRoot: string, summaryPath: string): string {
  return relative(repoRoot, summaryPath)
    .replaceAll("\\", "/")
    .replace(/\/coverage\/coverage-summary\.json$/, "");
}

/** Per-package coverage percentages, one row per matched summary. */
export function collectPerPackage(ctx: Ctx): PkgCoverage[] {
  const out: PkgCoverage[] = [];
  for (const glob of ctx.config.coverage.summaryGlobs) {
    for (const path of expandGlob(ctx.repoRoot, glob)) {
      const counts = readSummaryCounts(path);
      if (!counts) continue;
      out.push({
        pkg: pkgKey(ctx.repoRoot, path),
        totals: { functions: pct(counts.functions), lines: pct(counts.lines) },
      });
    }
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/**
 * Decide what a budget entry with NO coverage summary means.
 *
 * In a full run it means the package is gone from the repository and its floor is dead
 * config — that is the `stale` case, and it must stay a failure or `coverage-budgets.json`
 * silently accumulates entries for packages nobody can lower.
 *
 * In a PARTIAL run (`--partial`, for CI that only ran the affected packages) the same absence
 * usually means "this package was not run", which is expected and must not fail. The two are
 * indistinguishable from the summaries alone, so partial mode does NOT simply switch the check
 * off — it asks the filesystem. A budget entry whose package directory still exists was merely
 * not run; one whose directory is gone is stale exactly as before.
 *
 * That distinction is the whole point. Disabling the stale check under `--partial` would make
 * the flag a way to hide dead floors, and every CI run would use it.
 */
export function checkPerPackage(
  perPkg: PkgCoverage[],
  budgets: Budgets,
  opts: { partial?: boolean; packageExists?: (pkg: string) => boolean } = {},
): { failures: PkgFailure[]; newPkgs: string[]; stale: string[]; notRun: string[] } {
  const failures: PkgFailure[] = [];
  const newPkgs: string[] = [];
  const seen = new Set<string>();
  for (const { pkg, totals } of perPkg) {
    seen.add(pkg);
    const explicit = budgets.packages[pkg];
    const floor = explicit ?? budgets.default;
    const isNew = explicit === undefined;
    if (isNew) newPkgs.push(pkg);
    for (const metric of ["functions", "lines"] as const) {
      if (totals[metric] < floor[metric]) {
        failures.push({ pkg, metric, actual: totals[metric], floor: floor[metric], isNew });
      }
    }
  }
  const unmatched = Object.keys(budgets.packages).filter((p) => !seen.has(p));
  if (!opts.partial) return { failures, newPkgs, stale: unmatched, notRun: [] };
  // Fail CLOSED when the caller gives no existence probe. Defaulting to "it exists" would
  // excuse every unmatched entry and quietly turn --partial into a stale-check off-switch, which
  // is the failure this whole branch is written to avoid. Defaulting to "it does not" degrades
  // to ordinary full-run strictness instead, so a caller who forgets the probe gets a loud
  // wrong answer rather than a silent permissive one.
  const exists = opts.packageExists ?? (() => false);
  const stale: string[] = [];
  const notRun: string[] = [];
  for (const pkg of unmatched) (exists(pkg) ? notRun : stale).push(pkg);
  return { failures, newPkgs, stale, notRun };
}

/** A floor 0.5pt below the measured value, to absorb run-to-run noise. */
export function seedFloor(pct_: number): number {
  return Math.max(0, Math.floor((pct_ - 0.5) * 100) / 100);
}

export function seedBudgets(perPkg: PkgCoverage[], keepDefault: Floor): Budgets {
  const packages: Record<string, Floor> = {};
  for (const { pkg, totals } of perPkg.slice().sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    packages[pkg] = { functions: seedFloor(totals.functions), lines: seedFloor(totals.lines) };
  }
  return { default: keepDefault, packages };
}

function runTestCoverage(ctx: Ctx): number {
  const [cmd, ...args] = ctx.config.runner.split(/\s+/);
  const proc = spawnSync(cmd ?? "pnpm", [...args, "test:coverage"], {
    cwd: ctx.repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (proc.error) {
    console.error(
      `check-coverage: could not run '${ctx.config.runner} test:coverage': ${proc.error.message}`,
    );
    return 1;
  }
  return proc.status ?? 1;
}

export function lowest(perPkg: PkgCoverage[]): { pkg: string; lines: number } | undefined {
  let min: { pkg: string; lines: number } | undefined;
  for (const { pkg, totals } of perPkg) {
    if (!min || totals.lines < min.lines) min = { pkg, lines: totals.lines };
  }
  return min;
}

/** The `check:all` headline for coverage: the lowest package + how many meet
 *  their floor. `undefined` when there are no packages. */
export function coverageScore(perPkg: PkgCoverage[]): string | undefined {
  const min = lowest(perPkg);
  if (!min) return undefined;
  return `coverage — lowest ${min.pkg} ${min.lines.toFixed(1)}% lines (${perPkg.length} pkgs ≥ floor)`;
}

/** Run the coverage guard. Returns the process exit code. `init` seeds the
 *  floors; `skipRun` reads already-produced summaries without re-running;
 *  `partial` accepts that only some packages were run (see checkPerPackage). */
export function runCoverage(
  ctx: Ctx,
  opts: { init?: boolean; skipRun?: boolean; partial?: boolean } = {},
): number {
  const budgetsPath = resolve(ctx.repoRoot, ctx.config.coverage.budgetsPath);
  const testExit = opts.skipRun ? 0 : runTestCoverage(ctx);

  const perPkg = collectPerPackage(ctx);
  if (perPkg.length === 0) {
    console.error(
      "check-coverage: no coverage-summary.json files matched " +
        `${ctx.config.coverage.summaryGlobs.join(", ")} — did test:coverage run with the ` +
        "json-summary reporter?",
    );
    return testExit === 0 ? 1 : testExit;
  }

  if (opts.init) {
    if (!opts.skipRun && testExit !== 0) {
      console.error(
        "check-coverage: --init aborted — test:coverage failed; refusing to seed floors " +
          "from a failed/partial run. Fix the tests, then re-seed.",
      );
      return testExit;
    }
    if (opts.partial) {
      // Seeding from a partial run would delete every unrun package's floor, silently
      // dropping the ratchet for most of the repository. --init means "record the whole
      // baseline", which a partial run cannot supply.
      console.error(
        "check-coverage: --init cannot be combined with --partial — seeding from a subset " +
          "would drop the floors of every package that did not run. Re-seed from a full run.",
      );
      return 1;
    }
    const keepDefault = existsSync(budgetsPath)
      ? loadBudgets(readFileSync(budgetsPath, "utf8"), ctx.config.coverage.budgetsPath).default
      : DEFAULT_MIN;
    const budgets = seedBudgets(perPkg, keepDefault);
    const file = {
      _comment:
        "Per-package coverage floors. Each package is held to its own floor (packages[dir]) " +
        "or `default` if unlisted; floors only ratchet UP. Seeded 0.5pt below each baseline.",
      default: budgets.default,
      packages: budgets.packages,
    };
    writeFileSync(budgetsPath, `${JSON.stringify(file, null, 2)}\n`);
    console.log(
      `check-coverage: seeded per-package floors for ${perPkg.length} package(s) ` +
        `(default ${budgets.default.functions}/${budgets.default.lines}) → ${budgetsPath}`,
    );
    return 0;
  }

  const budgets = loadBudgets(readFileSync(budgetsPath, "utf8"), ctx.config.coverage.budgetsPath);
  const { failures, newPkgs, stale, notRun } = checkPerPackage(perPkg, budgets, {
    partial: opts.partial,
    // Probe for the package MANIFEST, not the directory. Raised in review on PR #12, which
    // pointed out that `existsSync(dir)` also returns true for a regular file. That is real,
    // and the likelier failure is worse: `git rm -r packages/x` leaves the directory behind
    // whenever it holds gitignored contents, and every workspace package has a node_modules.
    // So a directory probe would hold a deleted package's floor forever, which is precisely
    // the dead-floor accumulation --partial is designed not to cause.
    //
    // A package.json is what makes a directory a package, so its absence answers the question
    // being asked rather than a proxy for it. It also covers the file case for free: a regular
    // file at `packages/x` has no `packages/x/package.json`.
    packageExists: (pkg) => existsSync(resolve(ctx.repoRoot, pkg, "package.json")),
  });

  if (stale.length > 0) {
    console.error(`${ctx.config.coverage.budgetsPath} lists packages with no coverage summary:`);
    for (const p of stale) console.error(`  - ${p}`);
    console.error(
      opts.partial
        ? "Their package directories are gone, so this is not just an unrun package. " +
            "Remove these entries (or restore the package).\n"
        : "Remove these entries (or restore the package's coverage).\n",
    );
  }

  if (notRun.length > 0) {
    // Reported, not silent: a partial run that covered almost nothing should be visible in the
    // log rather than looking identical to a full green one.
    console.error(
      `check-coverage: --partial — ${perPkg.length} package(s) checked, ` +
        `${notRun.length} not run this time and holding their existing floors:`,
    );
    for (const p of notRun) console.error(`  - ${p}`);
    console.error("");
  }

  if (failures.length > 0) {
    console.error("Coverage below floor:");
    for (const f of failures) {
      const tag = f.isNew ? " [new package — no explicit floor, using default]" : "";
      console.error(
        `  ${f.pkg}: ${f.metric} ${f.actual.toFixed(2)}% < floor ${f.floor.toFixed(2)}%${tag}`,
      );
    }
    console.error(
      "\nAdd tests to lift it, or — if intentional — lower that package's floor in " +
        `${ctx.config.coverage.budgetsPath}. A new package needs tests to clear the default ` +
        `(${budgets.default.functions}%/${budgets.default.lines}%) or an explicit floor via --init.`,
    );
    return testExit === 0 ? 1 : testExit;
  }

  if (stale.length > 0) return 1;

  const min = lowest(perPkg);
  const newNote = newPkgs.length > 0 ? `; ${newPkgs.length} new pkg(s) met default` : "";
  console.error(
    `Coverage OK — ${perPkg.length} package(s) meet their floor` +
      (min ? `; lowest lines: ${min.pkg} ${min.lines.toFixed(2)}%` : "") +
      newNote,
  );
  const score = coverageScore(perPkg);
  if (score) console.log(`SCORE: ${score}`);
  return testExit;
}
