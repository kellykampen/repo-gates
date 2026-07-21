/**
 * Bundle-size guard (ratchet).
 *
 * For each configured target it builds the target (turbo, cached), scans
 * its dist dir, and enforces a ratchet per bucket (js/css/…):
 *   - totals.raw / totals.gzip — total bytes per bucket
 *   - largest.gzip            — the single largest chunk per bucket
 *     (catches one chunk ballooning even when the total stays flat).
 *
 * The ratchet only goes DOWN: code-split / trim deps, then lower the
 * budget. `--init` re-baselines from a fresh build (measured + headroom).
 * Especially valuable for the Cloudflare worker target, where the bundle
 * has a HARD size limit — this fails the PR instead of the prod deploy.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Ctx } from "./config.ts";

type BucketDef = Record<string, string[]>;
export type BucketSize = { raw: number; gzip: number; largest: number };
export type Measurement = {
  buckets: Record<string, BucketSize>;
  files: { name: string; bucket: string; raw: number; gzip: number }[];
};
export type TargetBudget = {
  totals: { raw: Record<string, number>; gzip: Record<string, number> };
  largest: { gzip: Record<string, number> };
};
export type Budgets = Record<string, TargetBudget>;
export type Failure = {
  target: string;
  metric: string;
  bucket: string;
  actual: number;
  budget: number;
};

/** Headroom added when seeding a budget from a measurement (absorbs trivial
 *  churn; the build is byte-reproducible from the lockfile). */
const HEADROOM = { raw: 2048, gzip: 512 };

function bucketFor(name: string, buckets: BucketDef): string | undefined {
  for (const [bucket, exts] of Object.entries(buckets)) {
    if (exts.some((ext) => name.endsWith(ext))) return bucket;
  }
  return undefined;
}

export function measure(distDir: string, buckets: BucketDef): Measurement {
  const out: Measurement = { buckets: {}, files: [] };
  for (const b of Object.keys(buckets)) out.buckets[b] = { raw: 0, gzip: 0, largest: 0 };
  if (!existsSync(distDir)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const bucket = bucketFor(entry, buckets);
      if (!bucket) continue;
      const buf = readFileSync(full);
      const raw = buf.length;
      const gzip = gzipSync(buf).length;
      out.files.push({ name: entry, bucket, raw, gzip });
      const acc = out.buckets[bucket];
      if (!acc) continue;
      acc.raw += raw;
      acc.gzip += gzip;
      if (gzip > acc.largest) acc.largest = gzip;
    }
  };
  walk(distDir);
  return out;
}

export function loadBudgets(raw: string, source = "bundle-size-budgets"): Budgets {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Budgets = {};
  for (const [target, value] of Object.entries(parsed)) {
    if (target.startsWith("_") || target.startsWith("$")) continue;
    const v = value as TargetBudget | undefined;
    if (!v?.totals?.raw || !v.totals.gzip || !v.largest?.gzip) {
      throw new Error(`${source}: ${target} missing totals.raw / totals.gzip / largest.gzip`);
    }
    out[target] = v;
  }
  return out;
}

export function diff(target: string, m: Measurement, budget: TargetBudget): Failure[] {
  const failures: Failure[] = [];
  for (const bucket of Object.keys(m.buckets)) {
    const size = m.buckets[bucket];
    if (!size) continue;
    const checks: [string, number, number | undefined][] = [
      ["totals.raw", size.raw, budget.totals.raw[bucket]],
      ["totals.gzip", size.gzip, budget.totals.gzip[bucket]],
      ["largest.gzip", size.largest, budget.largest.gzip[bucket]],
    ];
    for (const [metric, actual, cap] of checks) {
      if (cap !== undefined && actual > cap) {
        failures.push({ target, metric, bucket, actual, budget: cap });
      }
    }
  }
  return failures;
}

export function seedBudget(m: Measurement): TargetBudget {
  const out: TargetBudget = { totals: { raw: {}, gzip: {} }, largest: { gzip: {} } };
  for (const [bucket, size] of Object.entries(m.buckets)) {
    out.totals.raw[bucket] = size.raw + HEADROOM.raw;
    out.totals.gzip[bucket] = size.gzip + HEADROOM.gzip;
    out.largest.gzip[bucket] = size.largest + HEADROOM.gzip;
  }
  return out;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function buildTargets(ctx: Ctx): number {
  const filters = ctx.config.bundleSize.targets.flatMap((t) => ["--filter", t.filter]);
  if (filters.length === 0) return 0;
  const proc = spawnSync("pnpm", ["exec", "turbo", "run", "build", ...filters], {
    cwd: ctx.repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (proc.error) {
    console.error(`check-bundle-size: failed to build targets: ${proc.error.message}`);
    return 1;
  }
  return proc.status ?? 1;
}

/** Run the bundle-size guard. Returns the process exit code. */
export function runBundleSize(ctx: Ctx, init = false): number {
  const { budgetsPath, targets } = ctx.config.bundleSize;
  if (targets.length === 0) {
    console.log("Bundle-size guard: no targets configured — skipping.");
    return 0;
  }
  const buildExit = buildTargets(ctx);
  if (buildExit !== 0) return buildExit;

  const path = resolve(ctx.repoRoot, budgetsPath);
  const measurements: Record<string, Measurement> = {};
  for (const t of targets) {
    measurements[t.name] = measure(resolve(ctx.repoRoot, t.distDir), t.buckets);
  }

  if (init) {
    const budgets: Budgets = {};
    for (const t of targets)
      budgets[t.name] = seedBudget(measurements[t.name] ?? { buckets: {}, files: [] });
    const file = {
      _comment:
        "Bundle-size budgets per target (bytes). Ratchet only goes DOWN — code-split/trim, " +
        "then lower; never hand-raise. Re-baseline with `check:bundle-size --init`.",
      ...budgets,
    };
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`check-bundle-size: seeded budgets for ${targets.length} target(s) → ${path}`);
    return 0;
  }

  const budgets = loadBudgets(readFileSync(path, "utf8"), budgetsPath);
  const failures: Failure[] = [];
  const scoreParts: string[] = [];
  for (const t of targets) {
    const m = measurements[t.name];
    if (!m) continue;
    const budget = budgets[t.name];
    if (!budget) {
      console.error(`check-bundle-size: no budget for target "${t.name}" — run --init.`);
      return 1;
    }
    failures.push(...diff(t.name, m, budget));
    const gzipTotal = Object.values(m.buckets).reduce((s, b) => s + b.gzip, 0);
    scoreParts.push(`${t.name} ${fmtBytes(gzipTotal)} gz`);
  }

  if (failures.length > 0) {
    console.error("Bundle-size guard failed:");
    for (const f of failures) {
      console.error(
        `  ${f.target} ${f.metric}.${f.bucket}: ${fmtBytes(f.actual)} > budget ${fmtBytes(f.budget)} (+${f.actual - f.budget} B)`,
      );
    }
    console.error(
      "\nCode-split or trim deps to stay under budget. If the growth is intentional, " +
        "re-baseline with `pnpm run check:bundle-size -- --init` and commit the budget diff.",
    );
    return 1;
  }

  console.log(`SCORE: bundle-size — ${scoreParts.join(", ")}`);
  console.log("Bundle-size guard ok.");
  return 0;
}
