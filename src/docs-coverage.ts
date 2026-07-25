/**
 * Docs-coverage gate: block a PR that changes a user-facing surface but
 * adds no docs for it.
 *
 * WHAT COUNTS AS A SURFACE is `config.docsCoverage` (empty `surfaces` ⇒
 * no-op). A PR passes when either: no surface changed (nothing to gate); a
 * surface changed AND docs changed too; or the author opted out with an
 * escape hatch line `docs: n/a - <reason>` in the PR body. Otherwise it
 * fails closed.
 *
 * This is inherently a *pull-request* gate (a PR body, a base/head diff) —
 * it reads the changed-file list from the GitHub REST API using
 * `GITHUB_REPOSITORY` / `PR_NUMBER` / `GITHUB_TOKEN` / `PR_BODY`. Unlike
 * every other gate here, it deliberately does NOT hard-fail when those are
 * absent: a repo may wire `check:docs-coverage` into the local `check:all`
 * manifest (so it's part of the same battery as everything else), and a
 * local run or a plain `push` CI job has no PR to evaluate — that's a soft
 * no-op, not a failure. It only enforces when actually invoked with PR
 * context, e.g. a `pull_request`-triggered CI job (see the
 * `monorepo-turborepo.yml` example's comment on wiring this up).
 *
 * Zero npm dependencies: Node built-ins + global fetch.
 */

import { readFileSync } from "node:fs";
import type { Ctx, RepoGatesConfig } from "./config.ts";

export type DocsCoverageConfig = RepoGatesConfig["docsCoverage"];

// --- glob matching (tiny, dependency-free) ---------------------------------

/** Convert a glob to an anchored RegExp. `*` matches within a path segment;
 *  `**` matches across segments (and `**​/` also matches zero directories). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++; // consume the second '*'
        if (glob[i + 1] === "/") i++; // consume '/', so `**​/` also spans zero dirs
      } else {
        re += "[^/]*";
      }
    } else if (c && "\\^$.|?+()[]{}/".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[] | undefined): boolean {
  return (globs ?? []).some((g) => globToRegExp(g).test(path));
}

// --- change-status semantics -------------------------------------------------

export type ChangedFile = { filename: string; status: string };

// GitHub file statuses that mean "this file is new".
const ADDED = new Set(["added", "copied"]);
// Statuses that mean "this file's content is present after the change".
const PRESENT = new Set(["added", "copied", "modified", "renamed", "changed"]);

/** Does a file (with its GitHub status) trigger the given surface rule? */
export function fileTriggersSurface(
  file: ChangedFile,
  surface: DocsCoverageConfig["surfaces"][number],
): boolean {
  if (!globToRegExp(surface.glob).test(file.filename)) return false;
  const set = surface.on === "added" ? ADDED : PRESENT;
  return set.has(file.status);
}

// --- core evaluation ----------------------------------------------------------

export type TriggeredSurface = { file: string; label: string };

/** Surfaces a PR touched that need docs. */
export function triggeredSurfaces(
  files: readonly ChangedFile[],
  config: DocsCoverageConfig,
): TriggeredSurface[] {
  const out: TriggeredSurface[] = [];
  for (const file of files) {
    if (matchesAny(file.filename, config.exclude)) continue;
    for (const surface of config.surfaces) {
      if (fileTriggersSurface(file, surface)) {
        out.push({ file: file.filename, label: surface.label });
        break; // one surface hit per file is enough
      }
    }
  }
  return out;
}

/** Did the PR add or update any docs (present, not excluded, under docsGlobs)? */
export function hasDocsChange(files: readonly ChangedFile[], config: DocsCoverageConfig): boolean {
  return files.some(
    (f) =>
      PRESENT.has(f.status) &&
      !matchesAny(f.filename, config.exclude) &&
      matchesAny(f.filename, config.docsGlobs),
  );
}

/** Remove fenced code so an escape-hatch example in a code block is not
 *  read as a real opt-out. */
export function stripFencedCode(markdown: string | undefined): string {
  return (markdown ?? "").replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

export type EscapeHatch = { present: false } | { present: true; reason: string };

/** The `docs: n/a - <reason>` opt-out, if present. Tolerates `n/a` or `na`,
 *  an optional leading list/quote marker, and any dash/colon before the
 *  reason. */
export function escapeHatch(body: string | undefined): EscapeHatch {
  const line = /^[ \t>*-]*docs:\s*n\/?a\b[ \t]*[-:—]?[ \t]*(.*)$/im;
  const match = line.exec(stripFencedCode(body));
  if (!match) return { present: false };
  return { present: true, reason: (match[1] ?? "").trim() };
}

export type Verdict =
  | { status: "skip" }
  | { status: "pass"; triggered: TriggeredSurface[] }
  | { status: "waived"; triggered: TriggeredSurface[]; reason: string }
  | { status: "fail"; triggered: TriggeredSurface[] };

/** The gate verdict.
 *    skip    — no surface changed; nothing to gate.
 *    pass    — a surface changed and docs changed too.
 *    waived  — a surface changed, no docs, but an escape hatch opted out.
 *    fail    — a surface changed, no docs, no escape hatch. */
export function evaluate(
  files: readonly ChangedFile[],
  body: string | undefined,
  config: DocsCoverageConfig,
): Verdict {
  const triggered = triggeredSurfaces(files, config);
  if (triggered.length === 0) return { status: "skip" };
  if (hasDocsChange(files, config)) return { status: "pass", triggered };
  const hatch = escapeHatch(body);
  if (hatch.present) return { status: "waived", triggered, reason: hatch.reason };
  return { status: "fail", triggered };
}

// --- GitHub plumbing ----------------------------------------------------------

/** Percent-encode the characters a GitHub Actions workflow command treats
 *  specially (`%`, `\r`, `\n`) so a multi-line message isn't mangled or
 *  truncated. See https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands */
export function escapeWorkflowCommand(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function notice(message: string): void {
  console.log(`::notice title=Docs coverage::${escapeWorkflowCommand(message)}`);
}

export async function fetchChangedFiles(opts: {
  repo: string;
  number: string;
  token: string;
}): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${opts.repo}/pulls/${opts.number}/files?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "repo-gates-docs-coverage",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} listing PR files: ${await res.text()}`);
    }
    const batch = (await res.json()) as { filename: string; status: string }[];
    for (const f of batch) files.push({ filename: f.filename, status: f.status });
    if (batch.length < 100) break;
  }
  return files;
}

/** Run the gate. Returns the process exit code. */
export async function runDocsCoverage(ctx: Ctx): Promise<number> {
  const config = ctx.config.docsCoverage;
  if (config.surfaces.length === 0) {
    console.log("docs-coverage: no surfaces configured — no-op.");
    return 0;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  const body = process.env.PR_BODY ?? "";

  if (!repo || !number || !token) {
    console.log("docs-coverage: not running in a PR context (no GITHUB_REPOSITORY/PR_NUMBER/GITHUB_TOKEN) — skipping.");
    return 0;
  }
  // PR_NUMBER flows into an API URL; keep it strictly numeric even though
  // GitHub only ever sets an integer here.
  if (!/^\d+$/.test(number)) {
    console.error(`docs-coverage: PR_NUMBER is not numeric: ${JSON.stringify(number)}`);
    return 1;
  }

  const files = await fetchChangedFiles({ repo, number, token });
  const result = evaluate(files, body, config);

  if (result.status === "skip") {
    notice("No user-facing surface changed in this PR — nothing to gate.");
    return 0;
  }

  const list = result.triggered.map((t) => `    - ${t.file}  (${t.label})`).join("\n");

  if (result.status === "pass") {
    console.log("SCORE: docs-coverage — surface changes accompanied by docs");
    console.log("docs-coverage: surface changes are accompanied by docs.");
    return 0;
  }

  if (result.status === "waived") {
    notice(
      `Docs opt-out accepted: "docs: n/a${result.reason ? ` - ${result.reason}` : ""}". Surface(s):\n${list}`,
    );
    return 0;
  }

  console.error("docs-coverage: this PR changes a user-facing surface but adds no docs:");
  console.error(list);
  console.error(
    "\n  Add or update docs for the change, OR — if it genuinely needs none — add a line",
  );
  console.error('  `docs: n/a - <reason>` to the PR body to opt out on the record.');
  return 1;
}

// Re-exported so a consumer's own PR-triggered workflow can load
// repo-gates.config.json directly (as fantastic-dev's original standalone
// script did) without going through loadContext, if it wants to run this
// from the base commit for tamper-resistance — see the README's CI section.
export function readDocsCoverageConfig(path: string): DocsCoverageConfig {
  const parsed = (
    JSON.parse(readFileSync(path, "utf8")) as { docsCoverage?: Partial<DocsCoverageConfig> }
  ).docsCoverage;
  return {
    docsGlobs: parsed?.docsGlobs ?? [],
    surfaces: parsed?.surfaces ?? [],
    exclude: parsed?.exclude ?? [],
  };
}
