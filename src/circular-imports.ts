/**
 * Circular-import detector (ratchet).
 *
 * Walks `scanRoots` (same universe as the debt-marker/file-size guards),
 * extracts each file's *relative* import/require specifiers, and resolves
 * them to files on disk. A directed graph of that resolved edge set is
 * reduced to its non-trivial strongly-connected components (Tarjan) — each
 * one is a group of files that import each other in a cycle.
 *
 * Scope: only relative specifiers (`./x`, `../x`) are resolved, so this
 * finds cycles *within* a scanned tree, not cross-package cycles reached
 * through a bare workspace-package specifier (e.g. `@acme/a` importing back
 * into `@acme/b` which imports `@acme/a`) — that needs package-graph
 * resolution this tool doesn't have.
 *
 * Like `check-debt`, new cycles fail the gate; existing ones are
 * grandfathered into an allowlist (`path, path, …` signatures) that can
 * only shrink. `--init` seeds it from the current tree.
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Ctx } from "./config.ts";
import { hasExtension, walk } from "./lib/fs.ts";

export type AllowlistFile = { _comment?: string; allowlist: string[] };

export type Cycle = { files: string[] };

const IMPORT_SPEC_RE =
  /(?:from|require\()\s*["'](\.[^"'\n]+)["']|import\(\s*["'](\.[^"'\n]+)["']\s*\)|^\s*import\s+["'](\.[^"'\n]+)["']/gm;

/** Extract every relative import/require specifier from a source file:
 *  `import … from "./x"`, `require("./x")`, `import("./x")`, and the
 *  bare side-effect form `import "./x"` (no `from`). */
export function extractRelativeSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_SPEC_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) out.push(spec);
  }
  return out;
}

/** Resolve a relative specifier from `fromFile` to a real file on disk,
 *  trying each source extension and an `/index.<ext>` fallback — mirrors
 *  Node/TS module resolution closely enough for local relative imports. */
export function resolveSpecifier(
  fromFile: string,
  spec: string,
  sourceExtensions: readonly string[],
): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...sourceExtensions.map((ext) => base + ext),
    ...sourceExtensions.map((ext) => resolve(base, `index${ext}`)),
  ];
  return candidates.find(isFile);
}

function isFile(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile();
}

/** Tarjan's SCC algorithm, iterative to avoid recursion-depth limits on
 *  large graphs. Returns every strongly-connected component of size > 1
 *  (a genuine cycle — a lone node is never its own SCC here since the
 *  graph has no self-loops from this extractor). */
export function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    // Explicit work-stack DFS: [node, neighborIterator-position].
    const frames: { node: string; neighbors: string[]; i: number }[] = [
      { node: v, neighbors: [...(graph.get(v) ?? [])], i: 0 },
    ];

    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (!frame) break;
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];
        if (w === undefined) continue;
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlink.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          frames.push({ node: w, neighbors: [...(graph.get(w) ?? [])], i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node) ?? 0, indices.get(w) ?? 0));
        }
      } else {
        frames.pop();
        const parent = frames.at(-1);
        if (parent) {
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(frame.node) ?? 0),
          );
        }
        if (lowlink.get(frame.node) === indices.get(frame.node)) {
          const scc: string[] = [];
          let w: string | undefined;
          do {
            w = stack.pop();
            if (w === undefined) break;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);
          if (scc.length > 1) sccs.push(scc);
        }
      }
    }
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return sccs;
}

export function buildGraph(ctx: Ctx): Map<string, Set<string>> {
  const { scanRoots, excludeDirSegments, sourceExtensions } = ctx.config;
  const graph = new Map<string, Set<string>>();
  for (const root of scanRoots) {
    for (const abs of walk(resolve(ctx.repoRoot, root), excludeDirSegments)) {
      if (!hasExtension(abs, sourceExtensions)) continue;
      const source = readFileSync(abs, "utf8");
      const edges = graph.get(abs) ?? new Set<string>();
      for (const spec of extractRelativeSpecifiers(source)) {
        const target = resolveSpecifier(abs, spec, sourceExtensions);
        if (target && target !== abs) edges.add(target);
      }
      graph.set(abs, edges);
    }
  }
  return graph;
}

function toSignature(ctx: Ctx, files: string[]): string {
  return files
    .map((f) => relative(ctx.repoRoot, f).replaceAll("\\", "/"))
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

export function parseAllowlist(allowlistPath: string): string[] {
  if (!existsSync(allowlistPath)) return [];
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8")) as Record<string, unknown>;
  const list = raw.allowlist;
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
    throw new Error(`${allowlistPath}: "allowlist" must be an array of cycle-signature strings`);
  }
  return list as string[];
}

export function scan(ctx: Ctx): { untracked: Cycle[]; staleAllowlistEntries: string[] } {
  const graph = buildGraph(ctx);
  const cycles = findCycles(graph);
  const signatures = cycles.map((files) => toSignature(ctx, files));
  const allowlist = parseAllowlist(resolve(ctx.repoRoot, ctx.config.circular.allowlistPath));
  const allowSet = new Set(allowlist);
  const matched = new Set<string>();

  const untracked: Cycle[] = [];
  for (let i = 0; i < cycles.length; i++) {
    const sig = signatures[i];
    const files = cycles[i];
    if (sig === undefined || files === undefined) continue;
    if (allowSet.has(sig)) matched.add(sig);
    else untracked.push({ files: sig.split(", ") });
  }
  const staleAllowlistEntries = allowlist.filter((sig) => !matched.has(sig));
  return { untracked, staleAllowlistEntries };
}

export function seedAllowlist(ctx: Ctx): string[] {
  const emptyCtx: Ctx = {
    ...ctx,
    config: { ...ctx.config, circular: { allowlistPath: "\0missing" } },
  };
  return scan(emptyCtx)
    .untracked.map((c) => c.files.join(", "))
    .sort((a, b) => a.localeCompare(b));
}

export function writeSeed(ctx: Ctx): { path: string; count: number } {
  const path = resolve(ctx.repoRoot, ctx.config.circular.allowlistPath);
  const allowlist = seedAllowlist(ctx);
  const file: AllowlistFile = {
    _comment:
      "Grandfathered circular-import groups (comma-separated, sorted repo-relative paths — " +
      "one strongly-connected component per entry). Ratchet only goes down.",
    allowlist,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, count: allowlist.length };
}

/** Run the guard. Returns the process exit code. */
export function runCircularImports(ctx: Ctx, init = false): number {
  if (init) {
    const { path, count } = writeSeed(ctx);
    console.log(`circular-import guard: seeded ${count} grandfathered cycle(s) → ${path}`);
    return 0;
  }
  const { untracked, staleAllowlistEntries } = scan(ctx);

  if (staleAllowlistEntries.length > 0) {
    console.error(`${ctx.config.circular.allowlistPath} has entries that no longer cycle:`);
    for (const sig of staleAllowlistEntries) console.error(`  - ${sig}`);
    console.error("Remove these entries — the ratchet only goes down.\n");
  }

  if (untracked.length > 0) {
    console.error("New circular imports found:");
    for (const c of untracked) console.error(`  ${c.files.join(" -> ")} -> ${c.files[0]}`);
    console.error(
      "\nBreak the cycle (extract shared code, invert one of the imports), or — with " +
        "justification — allowlist it via `repo-gates check-circular --init`.",
    );
    return 1;
  }
  if (staleAllowlistEntries.length > 0) return 1;
  const grandfathered = parseAllowlist(resolve(ctx.repoRoot, ctx.config.circular.allowlistPath))
    .length;
  console.log(`SCORE: circular-imports — ${grandfathered} grandfathered, 0 new`);
  console.log("Circular-import guard ok.");
  return 0;
}
