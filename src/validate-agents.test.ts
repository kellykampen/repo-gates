import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import {
  extractBacktickedPaths,
  extractFencedBashBlocks,
  extractScriptRefs,
  validateAgents,
} from "./validate-agents.ts";

function agentsCtx(root: string): Ctx {
  return {
    repoRoot: root,
    config: { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, targets: ["AGENTS.md"] } },
  };
}

const IGNORED = ["run", "install", "exec"];

describe("extractFencedBashBlocks", () => {
  it("returns the body of bash/sh/shell fences", () => {
    const md = "text\n```bash\npnpm test\n```\nmore\n```ts\nconst x = 1\n```\n";
    expect(extractFencedBashBlocks(md)).toEqual(["pnpm test\n"]);
  });
});

describe("extractScriptRefs", () => {
  it("captures `pnpm run x` and bare `pnpm x`, skipping builtins", () => {
    const refs = extractScriptRefs(["pnpm run lint\npnpm test\npnpm install\n"], "pnpm", IGNORED);
    expect([...refs].sort()).toEqual(["lint", "test"]);
  });

  it("does not capture flags like --filter", () => {
    const refs = extractScriptRefs(["pnpm --filter @x/desktop run rebuild\n"], "pnpm", IGNORED);
    expect(refs.has("--filter")).toBe(false);
  });

  it("ignores commented-out lines", () => {
    expect(extractScriptRefs(["# pnpm run gone\npnpm run kept\n"], "pnpm", IGNORED)).toEqual(
      new Set(["kept"]),
    );
  });
});

describe("extractBacktickedPaths", () => {
  it("returns slash-bearing paths and skips bare filenames / urls / scoped pkgs / globs", () => {
    const md = "`apps/web/vite.config.ts` `zsh-wrapper.test.ts` `@x/db` `https://x.io` `src/**`";
    expect(extractBacktickedPaths(md)).toEqual(["apps/web/vite.config.ts"]);
  });
});

describe("validateAgents", () => {
  it("passes when scripts + paths resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-agents-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "x" } }));
    writeFileSync(join(root, "src.ts"), "x");
    writeFileSync(join(root, "AGENTS.md"), "```bash\npnpm run lint\n```\nSee `src.ts` maybe.\n");
    expect(validateAgents(agentsCtx(root))).toEqual([]);
  });

  it("flags a missing script, a missing path, and a missing doc", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-agents-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, "AGENTS.md"), "```bash\npnpm run gone\n```\n`missing/dir/x.ts`\n");
    const kinds = validateAgents(agentsCtx(root))
      .map((f) => f.kind)
      .sort();
    expect(kinds).toEqual(["missing-path", "missing-script"]);
  });

  it("reports a missing agent doc", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-agents-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    expect(validateAgents(agentsCtx(root))[0]?.kind).toBe("missing-doc");
  });
});
