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
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { Ctx } from "./config.ts";

type BucketDef = Record<string, string[]>;
export type BucketSize = { raw: number; gzip: number; largest: number };
export type Measurement = {
  buckets: Record<string, BucketSize>;
  /** `dir` is the slash-separated path from distDir to the file's directory
   *  (`""` at the top level). `name` stays the bare basename so existing
   *  consumers are unaffected. */
  files: { name: string; dir: string; bucket: string; raw: number; gzip: number }[];
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
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, relative ? posix.join(relative, entry) : entry);
        continue;
      }
      if (!st.isFile()) continue;
      const bucket = bucketFor(entry, buckets);
      if (!bucket) continue;
      const buf = readFileSync(full);
      const raw = buf.length;
      const gzip = gzipSync(buf).length;
      out.files.push({ name: entry, dir: relative, bucket, raw, gzip });
      const acc = out.buckets[bucket];
      if (!acc) continue;
      acc.raw += raw;
      acc.gzip += gzip;
      if (gzip > acc.largest) acc.largest = gzip;
    }
  };
  walk(distDir, "");
  return out;
}

/** Resolve a path's PARENT chain through any symlinks, leaving the final
 *  component alone.
 *
 *  `resolve()` is purely lexical — it collapses `..` as string arithmetic and
 *  never consults the filesystem — so `<root>/link/dist` passes a containment
 *  test on the string while `rmSync` happily follows `link` out of the repo.
 *
 *  The final component is deliberately NOT resolved: if the dist dir is itself
 *  a symlink, `rmSync` unlinks the link and leaves its target intact, which is
 *  the behaviour we want. Resolving it here would turn that into deleting the
 *  target. Components that do not exist yet cannot be symlinks, so walking up
 *  to the deepest existing ancestor is sufficient. */
function resolveParentThroughSymlinks(path: string): string {
  const trailing: string[] = [];
  let cursor = dirname(path);
  for (;;) {
    if (existsSync(cursor)) {
      return join(realpathSync(cursor), ...trailing.reverse(), basename(path));
    }
    const parent = dirname(cursor);
    if (parent === cursor) return path; // reached the filesystem root, nothing exists
    trailing.push(basename(cursor));
    cursor = parent;
  }
}

/** A dist dir must sit strictly inside the repo. `cleanDist` deletes
 *  recursively, so a config typo — or a symlink on the path — that resolved to
 *  the repo root or above would take the working tree with it.
 *
 *  Returns the symlink-resolved path, which is the one that was actually
 *  checked; deleting anything else would defeat the point of checking. */
export function assertSafeDistDir(distDir: string, repoRoot: string): string {
  const rawRoot = resolve(repoRoot);
  const root = existsSync(rawRoot) ? realpathSync(rawRoot) : rawRoot;
  const dir = resolveParentThroughSymlinks(resolve(rawRoot, distDir));
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

/** A trailing `-<segment>` before the extension: the shape a content hash takes.
 *  Matching the SHAPE is not enough to call it a hash — see `looksLikeHash`. */
const TRAILING_SEGMENT = /-([A-Za-z0-9_-]{8}|[0-9a-f]{16,})(\.[^.]+)$/;

/** Distinguish a content hash from an ordinary word, which is the whole
 *  difficulty: both are drawn from the same alphabet and both are commonly 8
 *  characters, so `react-markdown.js` and `ProjectArea-DWbILnNi.js` have the
 *  same shape.
 *
 *  Every hash observed in real Rollup/Vite output carries at least two capitals
 *  or a digit — `DWbILnNi`, `B2W0H_8K`, `llO5iolO`, `-GMgTQRt`. English words
 *  used as chunk names carry neither: `markdown`, `provider`, `callback`,
 *  `debounce`, `critical`, `messages`. A capitalised word (`Provider`) has one
 *  capital, so it stays on the word side of the line.
 *
 *  The rule is deliberately biased toward MISSING hashes. A miss costs one
 *  unreported duplicate pair, and a polluted dist produces many; `cleanDist`
 *  is the real defence and this is only a backstop. A false positive collapses
 *  two unrelated chunks into one logical name and makes the guard refuse to
 *  seed a clean dist — with advice ("remove dist and re-run") that reproduces
 *  the refusal identically, so the target can never be re-baselined at all. */
function looksLikeHash(segment: string): boolean {
  if (/^[0-9a-f]{16,}$/.test(segment)) return true; // long hex: unambiguous
  if (/[0-9]/.test(segment)) return true;
  return (segment.match(/[A-Z]/g) ?? []).length >= 2;
}

/** Strip a content hash so two builds of the same chunk share a name:
 *  `ProjectArea-DWbILnNi.js` and `ProjectArea-LeWXd_sH.js` both become
 *  `ProjectArea.js`, while `react-markdown.js` and `use-debounce.js` are
 *  left exactly as they are. */
export function logicalChunkName(name: string): string {
  const match = TRAILING_SEGMENT.exec(name);
  if (!match?.[1] || !looksLikeHash(match[1])) return name;
  return name.slice(0, match.index) + match[2];
}

export type DuplicateChunk = {
  bucket: string;
  /** Directory-qualified, so `dist/esm/index.js` and `dist/cjs/index.js` — the
   *  normal shape of a dual-format library build — are not mistaken for one
   *  chunk emitted twice.
   *
   *  This is a deliberate trade, and it costs real detection. Pollution whose
   *  two copies land in DIFFERENT directories now escapes: a build id in the
   *  output path (`.next/static/<buildId>/`), a renamed assets dir, a hashed
   *  directory name, or one copy at the top level and one under `assets/`.
   *  Basename grouping caught those and this does not.
   *
   *  There is no local signal separating the two cases — `esm/x-AAAA.js` +
   *  `cjs/x-BBBB.js` and `build1/x-AAAA.js` + `build2/x-BBBB.js` are the same
   *  shape. The trade goes this way because the failure modes are not
   *  symmetric: a false positive REFUSES a clean dist and tells the operator to
   *  remove it and re-run, which reproduces the refusal forever, while a false
   *  negative loses one backstop. `cleanDist` is the actual defence against
   *  layered output; this only catches a dist someone else laid out. */
  logical: string;
  files: { name: string; raw: number }[];
};

/** Find chunks that appear more than once under different content hashes.
 *
 *  This is the fingerprint of a dist dir holding two builds. It cannot arise
 *  from one build: a hash names the chunk's own bytes, so identical content
 *  yields an identical filename and overwrites rather than accumulates. The
 *  pairs even match in size, because what differs between them is usually the
 *  fixed-length hash inside an import specifier naming a sibling chunk. */
/** Order by code unit, not `localeCompare`. Collation depends on the ICU data
 *  the Node build ships with, so `"index"` sorts before `"ProjectArea"` under
 *  full ICU and after it without — which would reorder both this diagnostic
 *  output and any test asserting on it, for reasons unrelated to the bundle. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function findDuplicateChunks(m: Measurement): DuplicateChunk[] {
  const groups = new Map<string, DuplicateChunk>();
  for (const f of m.files) {
    const stripped = logicalChunkName(f.name);
    if (stripped === f.name) continue; // unhashed name — nothing to collide on
    const logical = f.dir ? posix.join(f.dir, stripped) : stripped;
    const key = `${f.bucket}\u0000${logical}`;
    const group = groups.get(key) ?? { bucket: f.bucket, logical, files: [] };
    group.files.push({ name: f.name, raw: f.raw });
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.files.length > 1)
    .map((g) => ({ ...g, files: g.files.slice().sort((a, b) => byCodeUnit(a.name, b.name)) }))
    .sort((a, b) => byCodeUnit(a.bucket, b.bucket) || byCodeUnit(a.logical, b.logical));
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
  // Paired with its target rather than keyed by name, so there is no lookup
  // that can miss. A `?? empty` fallback here would be the wrong default as
  // well as unreachable: it would seed a budget of pure headroom, which is
  // precisely what the empty-measurement guard below exists to refuse.
  const measured: { target: (typeof targets)[number]; m: Measurement }[] = [];
  for (const t of targets) {
    const m = measure(resolve(ctx.repoRoot, t.distDir), t.buckets);
    // Nothing to measure is a broken build, not a bundle of size zero — and
    // every ratchet passes trivially against it. This mattered less when the
    // dist dir was left alone, because a stale build masked the emptiness;
    // now that it is cleaned first, an output-less build would sail through.
    if (m.files.length === 0) {
      console.error(
        `check-bundle-size: ${t.distDir} holds no files matching ${t.name}'s buckets (${Object.keys(t.buckets).join(", ")}) after building. Nothing was measured, so the ratchet would pass regardless of the real size.`,
      );
      return 1;
    }
    measured.push({ target: t, m });
  }

  if (init) {
    const budgets: Budgets = {};
    for (const { target: t, m } of measured) {
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
  for (const { target: t, m } of measured) {
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
