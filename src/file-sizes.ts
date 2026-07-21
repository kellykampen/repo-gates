/**
 * Per-file line-count guard (ratchet).
 *
 *   - Files NOT listed in the budgets file must be ≤ config.fileSize.threshold.
 *   - Files listed in the budgets file must be ≤ their frozen budget (the
 *     file's line count when it was grandfathered in). The ratchet only
 *     goes DOWN: refactor and lower a budget, never raise it.
 *
 * `--init` writes the current over-threshold files as the grandfather
 * baseline so a repo adopting the gate is green on day one.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Ctx } from "./config.ts";
import { countLines, hasExtension, walk } from "./lib/fs.ts";

export type BudgetsFile = { _comment?: string; budgets: Record<string, number> };

export type SizeFailure = { path: string; lines: number; budget: number; reason: string };

export function loadBudgets(budgetsPath: string): Record<string, number> {
  if (!existsSync(budgetsPath)) return {};
  const raw = JSON.parse(readFileSync(budgetsPath, "utf8")) as Record<string, unknown>;
  const budgets = raw.budgets;
  if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new Error(`${budgetsPath}: "budgets" must be an object`);
  }
  const normalized: Record<string, number> = {};
  for (const [path, value] of Object.entries(budgets)) {
    if (typeof value !== "number" || value <= 0) {
      throw new Error(`${budgetsPath}: budgets["${path}"] must be a positive number`);
    }
    normalized[path] = value;
  }
  return normalized;
}

function shouldExclude(relPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => relPath.startsWith(prefix));
}

/** Every scanned source file with its repo-relative posix path + line count. */
export function collectFiles(ctx: Ctx): { rel: string; lines: number }[] {
  const { scanRoots, excludeDirSegments, excludePathPrefixes, sourceExtensions } = ctx.config;
  const out: { rel: string; lines: number }[] = [];
  for (const root of scanRoots) {
    for (const abs of walk(resolve(ctx.repoRoot, root), excludeDirSegments)) {
      const rel = relative(ctx.repoRoot, abs).replaceAll("\\", "/");
      if (!hasExtension(rel, sourceExtensions)) continue;
      if (shouldExclude(rel, excludePathPrefixes)) continue;
      out.push({ rel, lines: countLines(abs) });
    }
  }
  return out;
}

export function scan(ctx: Ctx): { failures: SizeFailure[]; staleBudgetEntries: string[] } {
  const threshold = ctx.config.fileSize.threshold;
  const budgets = loadBudgets(resolve(ctx.repoRoot, ctx.config.fileSize.budgetsPath));
  const failures: SizeFailure[] = [];
  const seen = new Set<string>();

  for (const { rel, lines } of collectFiles(ctx)) {
    seen.add(rel);
    const explicit = budgets[rel];
    if (explicit !== undefined) {
      if (lines > explicit) {
        failures.push({
          path: rel,
          lines,
          budget: explicit,
          reason: `exceeds frozen budget (${lines} > ${explicit}); refactor instead of raising the budget`,
        });
      }
    } else if (lines > threshold) {
      failures.push({
        path: rel,
        lines,
        budget: threshold,
        reason: `exceeds default threshold (${lines} > ${threshold}); split the file or add a justified budget entry`,
      });
    }
  }

  const staleBudgetEntries = Object.keys(budgets).filter((p) => !seen.has(p));
  return { failures, staleBudgetEntries };
}

/** Compute the grandfather baseline: every file currently over threshold,
 *  frozen at its present line count. */
export function seedBudgets(ctx: Ctx): Record<string, number> {
  const threshold = ctx.config.fileSize.threshold;
  const budgets: Record<string, number> = {};
  for (const { rel, lines } of collectFiles(ctx)) {
    if (lines > threshold) budgets[rel] = lines;
  }
  return Object.fromEntries(Object.entries(budgets).sort(([a], [b]) => a.localeCompare(b)));
}

export function writeSeed(ctx: Ctx): { path: string; count: number } {
  const path = resolve(ctx.repoRoot, ctx.config.fileSize.budgetsPath);
  const budgets = seedBudgets(ctx);
  const file: BudgetsFile = {
    _comment:
      "Grandfathered per-file line budgets. Files over the threshold are frozen at their " +
      "current line count; the ratchet only goes down. Refactor and lower these; never raise them.",
    budgets,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, count: Object.keys(budgets).length };
}

/** The scanned file with the least headroom to its budget/threshold — the
 *  one closest to failing the ratchet. */
export function tightest(
  ctx: Ctx,
): { path: string; lines: number; budget: number; headroom: number } | undefined {
  const threshold = ctx.config.fileSize.threshold;
  const budgets = loadBudgets(resolve(ctx.repoRoot, ctx.config.fileSize.budgetsPath));
  let best: { path: string; lines: number; budget: number; headroom: number } | undefined;
  for (const { rel, lines } of collectFiles(ctx)) {
    const budget = budgets[rel] ?? threshold;
    const headroom = budget - lines;
    if (!best || headroom < best.headroom) best = { path: rel, lines, budget, headroom };
  }
  return best;
}

/** Run the guard. Returns the process exit code. */
export function runFileSizes(ctx: Ctx, init = false): number {
  if (init) {
    const { path, count } = writeSeed(ctx);
    console.log(`file-size guard: seeded ${count} grandfathered budget(s) → ${path}`);
    return 0;
  }
  const { failures, staleBudgetEntries } = scan(ctx);

  if (staleBudgetEntries.length > 0) {
    console.error(`${ctx.config.fileSize.budgetsPath} has entries for files that no longer exist:`);
    for (const p of staleBudgetEntries) console.error(`  - ${p}`);
    console.error("Remove these entries to keep the budget honest.\n");
  }

  if (failures.length > 0) {
    console.error("File-size guard failed:");
    for (const f of failures) console.error(`  ${f.path}: ${f.reason}`);
    console.error(
      `\nThe ratchet only goes down — refactor large files into smaller modules ` +
        `rather than raising their budget.`,
    );
    return 1;
  }
  if (staleBudgetEntries.length > 0) return 1;
  const t = tightest(ctx);
  if (t) {
    console.log(
      `SCORE: file-size — tightest ${t.path} ${t.lines}/${t.budget} (${t.headroom} to spare)`,
    );
  }
  console.log("File-size guard ok.");
  return 0;
}
