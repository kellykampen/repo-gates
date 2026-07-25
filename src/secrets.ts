/**
 * Secret-shaped-string scanner (ratchet).
 *
 * A lightweight, dependency-free static scan for well-known credential
 * shapes (AWS/GitHub/Slack/Stripe/npm/Google API keys, PEM private-key
 * headers, userinfo-in-URL credentials — `config.secrets.patterns`) across
 * every **git-tracked** file in the repo, not just `scanRoots` — a leaked
 * secret is exactly as bad in a root `.env.example` or a YAML config as it
 * is in `src/`.
 *
 * This is NOT a substitute for a dedicated secret-scanning tool (gitleaks,
 * trufflehog): no entropy analysis, no git-history scan (only the current
 * tracked tree), and only the shapes above. It exists to catch an
 * accidental commit of a live token during normal review, not to be a
 * complete secrets program.
 *
 * A finding is reported as a path:line plus a redacted fingerprint
 * (`sha256` prefix) — the matched text itself is never printed. Like
 * `check-debt`, untracked findings fail the gate; existing ones are
 * grandfathered into an allowlist (`path:line` entries) that can only
 * shrink. `--init` seeds it from the current tree — review that seed
 * carefully, since it silences whatever it captures.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Ctx } from "./config.ts";
import { hasExtension } from "./lib/fs.ts";

export type AllowlistFile = { _comment?: string; allowlist: string[] };

export type Finding = { path: string; line: number; pattern: string; fingerprint: string };

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

/** Every git-tracked file, repo-relative, forward-slashed. Empty on any
 *  git failure (e.g. not a git repo) rather than throwing — callers decide
 *  whether that's fatal. */
export function listTrackedFiles(repoRoot: string): string[] {
  const proc = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  if (proc.status !== 0 || !proc.stdout) return [];
  return proc.stdout.split("\0").filter((f) => f.length > 0);
}

function fingerprint(matched: string): string {
  return createHash("sha256").update(matched).digest("hex").slice(0, 8);
}

function buildPatternRe(patterns: readonly string[]): RegExp {
  return new RegExp(`(${patterns.join(")|(")})`);
}

export function scan(ctx: Ctx): { untracked: Finding[]; staleAllowlistEntries: string[] } {
  const { excludeDirSegments, excludePathPrefixes, secrets } = ctx.config;
  const patternRe = buildPatternRe(secrets.patterns);
  const { entries: allowlist, raw } = parseAllowlist(resolve(ctx.repoRoot, secrets.allowlistPath));
  const allowSet = new Set(raw);
  const matchedAllow = new Set<string>();

  const untracked: Finding[] = [];
  for (const rel of listTrackedFiles(ctx.repoRoot)) {
    if (hasExtension(rel, secrets.binaryExtensions)) continue;
    if (excludeDirSegments.some((seg) => rel.split("/").includes(seg))) continue;
    if (excludePathPrefixes.some((prefix) => rel.startsWith(prefix))) continue;

    const abs = resolve(ctx.repoRoot, rel);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue; // deleted-but-still-listed, or genuinely unreadable — skip, don't crash the gate
    }
    if (content.includes("\0")) continue; // binary content that slipped past the extension filter

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const match = line.match(patternRe);
      if (!match) continue;
      const key = `${rel}:${i + 1}`;
      const finding: Finding = {
        path: rel,
        line: i + 1,
        pattern: match[0].length > 12 ? `${match[0].slice(0, 4)}…` : "match",
        fingerprint: fingerprint(match[0]),
      };
      if (allowSet.has(key)) matchedAllow.add(key);
      else untracked.push(finding);
    }
  }

  const staleAllowlistEntries = allowlist
    .map((e) => `${e.path}:${e.line}`)
    .filter((key) => !matchedAllow.has(key));
  return { untracked, staleAllowlistEntries };
}

export function seedAllowlist(ctx: Ctx): string[] {
  const emptyCtx: Ctx = {
    ...ctx,
    config: { ...ctx.config, secrets: { ...ctx.config.secrets, allowlistPath: "\0missing" } },
  };
  return scan(emptyCtx)
    .untracked.map((f) => `${f.path}:${f.line}`)
    .sort((a, b) => a.localeCompare(b));
}

export function writeSeed(ctx: Ctx): { path: string; count: number } {
  const path = resolve(ctx.repoRoot, ctx.config.secrets.allowlistPath);
  const allowlist = seedAllowlist(ctx);
  const file: AllowlistFile = {
    _comment:
      "Grandfathered secret-shaped-string findings (path:line). Review each one BEFORE " +
      "trusting this seed — it silences whatever it captures. Ratchet only goes down.",
    allowlist,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, count: allowlist.length };
}

/** Run the guard. Returns the process exit code. */
export function runSecrets(ctx: Ctx, init = false): number {
  if (init) {
    const { path, count } = writeSeed(ctx);
    console.log(`secrets guard: seeded ${count} grandfathered finding(s) → ${path}`);
    console.log("Review every entry — the seed silences whatever it captures.");
    return 0;
  }
  const { untracked, staleAllowlistEntries } = scan(ctx);

  if (staleAllowlistEntries.length > 0) {
    console.error(`${ctx.config.secrets.allowlistPath} has entries that no longer match:`);
    for (const k of staleAllowlistEntries) console.error(`  - ${k}`);
    console.error("Remove these entries — the ratchet only goes down.\n");
  }

  if (untracked.length > 0) {
    console.error("Secret-shaped strings found (fingerprint only — never the matched text):");
    for (const f of untracked) {
      console.error(`  ${f.path}:${f.line}  fingerprint:${f.fingerprint}`);
    }
    console.error(
      "\nRotate and remove the credential, or — only if this is genuinely a false positive " +
        "(a test fixture, a placeholder) — allowlist it via `repo-gates check-secrets --init`.",
    );
    return 1;
  }
  if (staleAllowlistEntries.length > 0) return 1;
  const grandfathered = parseAllowlist(resolve(ctx.repoRoot, ctx.config.secrets.allowlistPath))
    .raw.length;
  console.log(`SCORE: secrets — ${grandfathered} grandfathered, 0 new`);
  console.log("Secrets guard ok.");
  return 0;
}
