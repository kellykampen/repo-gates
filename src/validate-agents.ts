/**
 * Agent-doc validator (check:agents).
 *
 * Fails when an agent doc (AGENTS.md / CLAUDE.md) drifts out of sync with the
 * repo: any package-manager script it references in a fenced bash block must
 * exist in package.json's scripts, and any backticked path-shaped token must
 * resolve on disk (or be listed in `agents.knownMissingPaths`).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Ctx } from "./config.ts";
import { loadScripts } from "./lib/pkg.ts";

export type Failure = { file: string; kind: string; detail: string };

export function extractFencedBashBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
  for (const m of markdown.matchAll(fence)) {
    if (m[1] !== undefined) blocks.push(m[1]);
  }
  return blocks;
}

function stripShellComments(block: string): string {
  return block
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Script names referenced via the package manager in bash blocks. Handles
 *  both `<pm> run <name>` (explicit) and bare `<pm> <name>` (skipping the
 *  configured builtin subcommands like install/exec). */
export function extractScriptRefs(
  blocks: string[],
  runnerCommand: string,
  ignoredSubcommands: readonly string[],
): Set<string> {
  const ignored = new Set(ignoredSubcommands);
  const pm = escapeRegExp(runnerCommand);
  const runRe = new RegExp(`\\b${pm}\\s+run\\s+([a-zA-Z0-9:_-]+)`, "g");
  // Bare form must start with an alphanumeric/colon so flags (`--filter`) and
  // option values aren't mistaken for script names.
  const bareRe = new RegExp(`\\b${pm}\\s+([a-zA-Z0-9:][a-zA-Z0-9:_-]*)`, "g");
  const out = new Set<string>();
  for (const raw of blocks) {
    const block = stripShellComments(raw);
    for (const m of block.matchAll(runRe)) if (m[1]) out.add(m[1]);
    for (const m of block.matchAll(bareRe)) {
      const name = m[1];
      if (name && name !== "run" && !ignored.has(name)) out.add(name);
    }
  }
  return out;
}

/** Backtick-quoted tokens that look like a repo path (contain `/` or a known
 *  doc/config extension). URLs, scoped packages, globs, placeholders skipped. */
export function extractBacktickedPaths(markdown: string): string[] {
  const paths: string[] = [];
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = (m[1] ?? "").trim();
    if (/^https?:\/\//.test(token)) continue;
    if (/\s/.test(token)) continue;
    if (token.startsWith("@")) continue;
    if (token.endsWith("...")) continue;
    if (/^\.[A-Za-z0-9]+$/.test(token)) continue;
    if (!/^[.A-Za-z0-9_][A-Za-z0-9_.\-/]*\/?$/.test(token)) continue;
    // Only validate real repo-relative paths (containing a slash). Bare
    // filenames in prose (`zsh-wrapper.test.ts`) are illustrative, not paths.
    if (!token.includes("/")) continue;
    const cleaned = token.replace(/\/+$/, "");
    if (cleaned.includes("<") || cleaned.includes(">") || cleaned.includes("*")) continue;
    paths.push(cleaned);
  }
  return paths;
}

export function validateAgents(ctx: Ctx): Failure[] {
  const { targets, knownMissingPaths, runnerCommand, ignoredSubcommands } = ctx.config.agents;
  const scripts = new Set(Object.keys(loadScripts(ctx.repoRoot)));
  const known = new Set(knownMissingPaths);
  const failures: Failure[] = [];

  for (const rel of targets) {
    const abs = resolve(ctx.repoRoot, rel);
    if (!existsSync(abs)) {
      failures.push({ file: rel, kind: "missing-doc", detail: `${rel} not found` });
      continue;
    }
    const src = readFileSync(abs, "utf8");

    for (const name of extractScriptRefs(
      extractFencedBashBlocks(src),
      runnerCommand,
      ignoredSubcommands,
    )) {
      if (!scripts.has(name)) {
        failures.push({
          file: rel,
          kind: "missing-script",
          detail: `\`${runnerCommand} ${name}\` referenced but not a package.json script`,
        });
      }
    }

    for (const p of extractBacktickedPaths(src)) {
      if (known.has(p)) continue;
      if (!existsSync(resolve(ctx.repoRoot, p))) {
        failures.push({
          file: rel,
          kind: "missing-path",
          detail: `referenced path \`${p}\` does not exist`,
        });
      }
    }
  }
  return failures;
}

/** Run the agent-doc validator. Returns the process exit code. */
export function runValidateAgents(ctx: Ctx): number {
  const { targets } = ctx.config.agents;
  if (targets.length === 0) {
    console.log("check:agents — no agent docs configured; skipping.");
    return 0;
  }
  const failures = validateAgents(ctx);
  if (failures.length === 0) {
    console.log(`✓ agent-doc validation passed (${targets.join(", ")})`);
    return 0;
  }
  console.error("✗ agent-doc validation failed:");
  for (const f of failures) console.error(`  [${f.kind}] ${f.file}: ${f.detail}`);
  return 1;
}
