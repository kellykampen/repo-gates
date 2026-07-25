import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import { extractRelativeSpecifiers, findCycles, scan, seedAllowlist } from "./circular-imports.ts";

function makeCtx(): { ctx: Ctx; root: string } {
  const root = mkdtempSync(join(tmpdir(), "repo-gates-circular-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const ctx: Ctx = {
    repoRoot: root,
    config: {
      ...DEFAULT_CONFIG,
      scanRoots: ["src"],
      circular: { allowlistPath: "allow.json" },
    },
  };
  return { ctx, root };
}

describe("extractRelativeSpecifiers", () => {
  it("finds from/require/dynamic-import specifiers, ignores bare packages", () => {
    const source = [
      'import { a } from "./a.ts";',
      'const b = require("../b.ts");',
      'const c = await import("./c.ts");',
      'import { x } from "some-package";',
    ].join("\n");
    expect(extractRelativeSpecifiers(source)).toEqual(["./a.ts", "../b.ts", "./c.ts"]);
  });
});

describe("findCycles", () => {
  it("finds no cycles in a DAG", () => {
    const graph = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set<string>()],
    ]);
    expect(findCycles(graph)).toEqual([]);
  });

  it("finds a two-node cycle", () => {
    const graph = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  it("finds a three-node cycle but not an unrelated node", () => {
    const graph = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["a"])],
      ["d", new Set<string>()],
    ]);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("circular-import scan", () => {
  it("flags a new two-file cycle", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'import "./b.ts";\n');
    writeFileSync(join(root, "src/b.ts"), 'import "./a.ts";\n');
    const { untracked } = scan(ctx);
    expect(untracked).toHaveLength(1);
    expect(untracked[0]?.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not flag a plain import chain", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'import "./b.ts";\n');
    writeFileSync(join(root, "src/b.ts"), "export const x = 1;\n");
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("silences a cycle listed in the allowlist", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'import "./b.ts";\n');
    writeFileSync(join(root, "src/b.ts"), 'import "./a.ts";\n');
    writeFileSync(join(root, "allow.json"), JSON.stringify({ allowlist: ["src/a.ts, src/b.ts"] }));
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("reports a stale allowlist entry once the cycle is broken", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'import "./b.ts";\n');
    writeFileSync(join(root, "src/b.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "allow.json"), JSON.stringify({ allowlist: ["src/a.ts, src/b.ts"] }));
    expect(scan(ctx).staleAllowlistEntries).toEqual(["src/a.ts, src/b.ts"]);
  });

  it("seeds every current cycle", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'import "./b.ts";\n');
    writeFileSync(join(root, "src/b.ts"), 'import "./a.ts";\n');
    expect(seedAllowlist(ctx)).toEqual(["src/a.ts, src/b.ts"]);
  });

  it("honors excludePathPrefixes", () => {
    const { ctx, root } = makeCtx();
    mkdirSync(join(root, "src/generated"), { recursive: true });
    writeFileSync(join(root, "src/generated/a.ts"), 'import "./b.ts";\n');
    writeFileSync(join(root, "src/generated/b.ts"), 'import "./a.ts";\n');
    const excluded: Ctx = {
      ...ctx,
      config: { ...ctx.config, excludePathPrefixes: ["src/generated"] },
    };
    expect(scan(excluded).untracked).toEqual([]);
  });
});
