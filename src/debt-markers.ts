/**
 * Debt-marker scanner (ratchet).
 *
 * Flags any TODO / FIXME / HACK / XXX (config.debt.markerTokens) that is
 * not paired with a tracker reference on the same line (a Linear-style
 * `ABC-123`, a `#123` issue ref, or a URL — config.debt.trackerPatterns).
 *
 * Untracked markers must be removed, paired with a tracker id, or — as an
 * escape hatch — grandfathered in the allowlist (`path:line` entries).
 * The ratchet only goes down. `--init` seeds the allowlist with every
 * current untracked marker so adoption is green on day one.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Ctx } from "./config.ts";
import { hasExtension, walk } from "./lib/fs.ts";

export type AllowlistFile = { _comment?: string; allowlist: string[] };

export type Marker = { path: string; line: number; marker: string; text: string };

type AllowlistEntry = { path: string; line: number };

export function parseAllowlist(allowlistPath: string): {
  entries: AllowlistEntry[];
  raw: string[];
} {
  if (!existsSync(allowlistPath)) return { entries: [], raw: [] };
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8")) as Record<string, unknown>;
  const list = raw.allowlist;
  if (!Array.isArray(list)) {
    throw new Error(`${allowlistPath}: "allowlist" must be an array of "path:line" strings`);
  }
  const entries: AllowlistEntry[] = [];
  const rawStrings: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") {
      throw new Error(`${allowlistPath}: allowlist entries must be "path:line" strings`);
    }
    const idx = item.lastIndexOf(":");
    const path = idx < 0 ? "" : item.slice(0, idx);
    const line = idx < 0 ? Number.NaN : Number.parseInt(item.slice(idx + 1), 10);
    if (!path || !Number.isInteger(line) || line <= 0) {
      throw new Error(`${allowlistPath}: "${item}" is not a valid "path:line" entry`);
    }
    entries.push({ path, line });
    rawStrings.push(item);
  }
  return { entries, raw: rawStrings };
}

function buildMarkerRe(tokens: readonly string[]): RegExp {
  return new RegExp(`\\b(${tokens.join("|")})\\b`);
}

function buildTrackerRes(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "i"));
}

function shouldExclude(
  relPath: string,
  prefixes: readonly string[],
  exact: ReadonlySet<string>,
): boolean {
  if (exact.has(relPath)) return true;
  return prefixes.some((prefix) => relPath.startsWith(prefix));
}

export function scan(ctx: Ctx): {
  untracked: Marker[];
  staleAllowlistEntries: string[];
} {
  const { scanRoots, excludeDirSegments, excludePathPrefixes, sourceExtensions, debt } = ctx.config;
  const markerRe = buildMarkerRe(debt.markerTokens);
  const trackerRes = buildTrackerRes(debt.trackerPatterns);
  const { entries: allowlist, raw } = parseAllowlist(resolve(ctx.repoRoot, debt.allowlistPath));
  const allowSet = new Set(raw);
  const matchedAllow = new Set<string>();
  // These files naturally contain the marker tokens they define/hunt for.
  const excludeExact = new Set([
    "packages/repo-gates/src/config.ts",
    "packages/repo-gates/src/debt-markers.ts",
    "packages/repo-gates/src/debt-markers.test.ts",
  ]);

  const untracked: Marker[] = [];
  for (const root of scanRoots) {
    for (const abs of walk(resolve(ctx.repoRoot, root), excludeDirSegments)) {
      const rel = relative(ctx.repoRoot, abs).replaceAll("\\", "/");
      if (!hasExtension(rel, sourceExtensions)) continue;
      if (shouldExclude(rel, excludePathPrefixes, excludeExact)) continue;
      const lines = readFileSync(abs, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const match = line.match(markerRe);
        if (!match) continue;
        if (trackerRes.some((re) => re.test(line))) continue;
        const key = `${rel}:${i + 1}`;
        const marker: Marker = {
          path: rel,
          line: i + 1,
          marker: match[1] ?? match[0],
          text: line.trim(),
        };
        if (allowSet.has(key)) matchedAllow.add(key);
        else untracked.push(marker);
      }
    }
  }

  const staleAllowlistEntries = allowlist
    .map((e) => `${e.path}:${e.line}`)
    .filter((key) => !matchedAllow.has(key));
  return { untracked, staleAllowlistEntries };
}

export function seedAllowlist(ctx: Ctx): string[] {
  // Seed against an empty allowlist so every current untracked marker is captured.
  const emptyCtx: Ctx = {
    ...ctx,
    config: { ...ctx.config, debt: { ...ctx.config.debt, allowlistPath: "\0missing" } },
  };
  return scan(emptyCtx)
    .untracked.map((m) => `${m.path}:${m.line}`)
    .sort((a, b) => a.localeCompare(b));
}

export function writeSeed(ctx: Ctx): { path: string; count: number } {
  const path = resolve(ctx.repoRoot, ctx.config.debt.allowlistPath);
  const allowlist = seedAllowlist(ctx);
  const file: AllowlistFile = {
    _comment:
      "Grandfathered untracked debt markers (path:line). Each must match an existing " +
      "TODO/FIXME/HACK/XXX with no tracker ref on the same line. Ratchet only goes down.",
    allowlist,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, count: allowlist.length };
}

/** Run the guard. Returns the process exit code. */
export function runDebtMarkers(ctx: Ctx, init = false): number {
  if (init) {
    const { path, count } = writeSeed(ctx);
    console.log(`debt-marker guard: seeded ${count} grandfathered marker(s) → ${path}`);
    return 0;
  }
  const { untracked, staleAllowlistEntries } = scan(ctx);

  if (staleAllowlistEntries.length > 0) {
    console.error(`${ctx.config.debt.allowlistPath} has entries that no longer match a marker:`);
    for (const k of staleAllowlistEntries) console.error(`  - ${k}`);
    console.error("Remove these entries — the ratchet only goes down.\n");
  }

  if (untracked.length > 0) {
    console.error("Untracked debt markers found:");
    for (const m of untracked) console.error(`  ${m.path}:${m.line}  ${m.marker}: ${m.text}`);
    console.error(
      `\nPair each marker with a tracker reference on the same line ` +
        `(ABC-123 / #123 / URL), remove it, or — with justification — allowlist it.`,
    );
    return 1;
  }
  if (staleAllowlistEntries.length > 0) return 1;
  const grandfathered = parseAllowlist(resolve(ctx.repoRoot, ctx.config.debt.allowlistPath)).raw
    .length;
  console.log(`SCORE: debt-markers — ${grandfathered} grandfathered, 0 untracked`);
  console.log("Debt-marker guard ok.");
  return 0;
}
