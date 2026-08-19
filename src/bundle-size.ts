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
 *
 * Each target's dist dir is REMOVED before the build. A build tool empties
 * its own output dir, but a cache hit skips the tool entirely and restores
 * cached outputs *into* whatever is already there — restore is additive,
 * because the cache cannot know which foreign files are safe to delete. Two
 * builds' hash-suffixed chunks then coexist and every one of them is counted.
 * Cleaning first makes restore exact and keeps the cache: the measurement
 * becomes a function of the build rather than of the directory's history.
 * Especially valuable for the Cloudflare worker target, where the bundle
 * has a HARD size limit — this fails the PR instead of the prod deploy.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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

/** A dist dir must sit strictly inside the repo and name a real subdirectory.
 *  `cleanDist` deletes recursively, so a config typo that resolved to the repo
 *  root — or anywhere above it — would take the working tree with it. */
export function assertSafeDistDir(distDir: string, repoRoot: string): string {
  const root = resolve(repoRoot);
  const dir = resolve(root, distDir);
  if (dir === root || !dir.startsWith(`${root}${sep}`)) {
    throw new Error(
      `check-bundle-size: distDir ${JSON.stringify(distDir)} resolves to ${dir}, which is not inside ${root}. Refusing to remove it.`,
    );
  }
  return dir;
}

/** Remove a target's dist dir so the build writes into an empty directory.
 *  Missing is fine — that is the state we are trying to reach. */
export function cleanDist(distDir: string, repoRoot: string): void {
  rmSync(assertSafeDistDir(distDir, repoRoot), { recursive: true, force: true });
}

/** Matches a trailing content hash. Two shapes, both deliberately narrow:
 *  Rollup/Vite's default base64url digest, which is EXACTLY 8 chars and may
 *  contain `-`/`_` at either end (`index--GMgTQRt.js`, `index-CEyAyFk-.js`);
 *  and a long lowercase-hex digest as webpack and friends emit.
 *
 *  Width is what separates a hash from a word, because the alphabets overlap.
 *  Allowing "8 or more" would eat the tail of `use-callback-ref.js` and leave
 *  `use.js` — which would then collide with every other `use-*` chunk and make
 *  the guard refuse to seed a clean dist. A miss here is cheap (cleanDist
 *  already prevents the pollution); a false positive blocks a real re-baseline. */
const CHUNK_HASH = /-(?:[A-Za-z0-9_-]{8}|[0-9a-f]{16,})(\.[^.]+)$/;

/** Strip a content hash so two builds of the same chunk share a name:
 *  `ProjectArea-DWbILnNi.js` and `ProjectArea-LeWXd_sH.js` both become
 *  `ProjectArea.js`, while `use-callback-ref.js` and `index.js` are untouched. */
export function logicalChunkName(name: string): string {
  return name.replace(CHUNK_HASH, "$1");
}

export type DuplicateChunk = { bucket: string; logical: string; files: { name: string; raw: number }[] };

/** Find chunks that appear more than once under different content hashes.
 *
 *  This is the fingerprint of a dist dir holding two builds. It cannot arise
 *  from one build: a hash names the chunk's own bytes, so identical content
 *  yields an identical filename and overwrites rather than accumulates. The
 *  pairs even match in size, because what differs between them is usually the
 *  fixed-length hash inside an import specifier naming a sibling chunk. */
export function findDuplicateChunks(m: Measurement): DuplicateChunk[] {
  const groups = new Map<string, DuplicateChunk>();
  for (const f of m.files) {
    const logical = logicalChunkName(f.name);
    if (logical === f.name) continue; // unhashed name — nothing to collide on
    const key = `${f.bucket}\u0000${logical}`;
    const group = groups.get(key) ?? { bucket: f.bucket, logical, files: [] };
    group.files.push({ name: f.name, raw: f.raw });
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.files.length > 1)
    .map((g) => ({ ...g, files: g.files.slice().sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.logical.localeCompare(b.logical));
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

/** Seams for the two effects the guard performs before it can measure.
 *  Exposed so tests can assert the ORDER: cleaning after the build would
 *  delete the outputs, and cleaning is only useful before one. */
export type BundleSizeDeps = {
  clean: (distDir: string, repoRoot: string) => void;
  build: (ctx: Ctx) => number;
};

const DEFAULT_DEPS: BundleSizeDeps = { clean: cleanDist, build: buildTargets };

/** Run the bundle-size guard. Returns the process exit code. */
export function runBundleSize(ctx: Ctx, init = false, deps: BundleSizeDeps = DEFAULT_DEPS): number {
  const { budgetsPath, targets } = ctx.config.bundleSize;
  if (targets.length === 0) {
    console.log("Bundle-size guard: no targets configured — skipping.");
    return 0;
  }
  for (const t of targets) deps.clean(t.distDir, ctx.repoRoot);
  const buildExit = deps.build(ctx);
  if (buildExit !== 0) return buildExit;

  const path = resolve(ctx.repoRoot, budgetsPath);
  const measurements: Record<string, Measurement> = {};
  for (const t of targets) {
    measurements[t.name] = measure(resolve(ctx.repoRoot, t.distDir), t.buckets);
  }

  if (init) {
    const budgets: Budgets = {};
    for (const t of targets) {
      const m = measurements[t.name] ?? { buckets: {}, files: [] };
      const duplicates = findDuplicateChunks(m);
      if (duplicates.length > 0) {
        console.error(
          `check-bundle-size: refusing to seed "${t.name}" — ${t.distDir} holds ${duplicates.length} chunk(s) emitted more than once:`,
        );
        for (const d of duplicates.slice(0, 5)) {
          console.error(`  ${d.logical}: ${d.files.map((f) => `${f.name} (${f.raw} B)`).join(", ")}`);
        }
        if (duplicates.length > 5) console.error(`  … and ${duplicates.length - 5} more`);
        console.error(
          `\nOne build cannot emit the same chunk twice, so this directory holds output from two. ` +
            `A budget seeded from it would be inflated by the surplus and, because the ratchet only ` +
            `goes DOWN, nothing later would catch it.\nRemove ${t.distDir} and re-run.`,
        );
        return 1;
      }
      budgets[t.name] = seedBudget(m);
    }
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
      "\nCode-split or trim deps to stay under budget.\n\n" +
        "Before re-baselining, confirm the growth is real: a budget seeded from a bad " +
        "measurement raises the ceiling permanently, and the ratchet only goes DOWN, so " +
        "nothing later will catch it. Check that the reported size matches what the build " +
        "actually emitted. Only if the growth is intentional, re-baseline with " +
        "`pnpm run check:bundle-size -- --init` and commit the budget diff.",
    );
    return 1;
  }

  console.log(`SCORE: bundle-size — ${scoreParts.join(", ")}`);
  console.log("Bundle-size guard ok.");
  return 0;
}
