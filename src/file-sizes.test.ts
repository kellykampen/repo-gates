import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import { scan, seedBudgets, tightest } from "./file-sizes.ts";

function makeCtx(threshold: number): { ctx: Ctx; root: string } {
  const root = mkdtempSync(join(tmpdir(), "repo-gates-size-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const ctx: Ctx = {
    repoRoot: root,
    config: {
      ...DEFAULT_CONFIG,
      scanRoots: ["src"],
      fileSize: { threshold, budgetsPath: "budgets.json" },
    },
  };
  return { ctx, root };
}

function writeLines(root: string, rel: string, n: number): void {
  writeFileSync(join(root, rel), `${"x\n".repeat(n)}`);
}

describe("file-size scan", () => {
  it("passes files under threshold and fails files over it", () => {
    const { ctx, root } = makeCtx(10);
    writeLines(root, "src/small.ts", 5);
    writeLines(root, "src/big.ts", 20);
    const { failures } = scan(ctx);
    expect(failures.map((f) => f.path)).toEqual(["src/big.ts"]);
    expect(failures[0]?.reason).toContain("20 > 10");
  });

  it("honors an explicit frozen budget", () => {
    const { ctx, root } = makeCtx(10);
    writeLines(root, "src/legacy.ts", 30);
    writeFileSync(join(root, "budgets.json"), JSON.stringify({ budgets: { "src/legacy.ts": 30 } }));
    expect(scan(ctx).failures).toEqual([]);

    writeLines(root, "src/legacy.ts", 31); // grew past its frozen budget
    expect(scan(ctx).failures).toHaveLength(1);
  });

  it("reports stale budget entries", () => {
    const { ctx, root } = makeCtx(10);
    writeFileSync(join(root, "budgets.json"), JSON.stringify({ budgets: { "src/gone.ts": 30 } }));
    expect(scan(ctx).staleBudgetEntries).toEqual(["src/gone.ts"]);
  });

  it("seeds only over-threshold files at their current line count", () => {
    const { ctx, root } = makeCtx(10);
    writeLines(root, "src/small.ts", 5);
    writeLines(root, "src/big.ts", 42);
    expect(seedBudgets(ctx)).toEqual({ "src/big.ts": 42 });
  });

  it("tightest reports the file with the least headroom to its cap", () => {
    const { ctx, root } = makeCtx(10);
    writeLines(root, "src/a.ts", 3); // headroom 7
    writeLines(root, "src/b.ts", 9); // headroom 1 — tightest
    const t = tightest(ctx);
    expect(t?.path).toBe("src/b.ts");
    expect(t?.headroom).toBe(1);
    expect(t?.budget).toBe(10);
  });
});
