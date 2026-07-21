import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import { parseAllowlist, scan, seedAllowlist } from "./debt-markers.ts";

function makeCtx(): { ctx: Ctx; root: string } {
  const root = mkdtempSync(join(tmpdir(), "repo-gates-debt-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const ctx: Ctx = {
    repoRoot: root,
    config: {
      ...DEFAULT_CONFIG,
      scanRoots: ["src"],
      debt: { ...DEFAULT_CONFIG.debt, allowlistPath: "allow.json" },
    },
  };
  return { ctx, root };
}

describe("debt-marker scan", () => {
  it("flags an untracked marker but not a tracked one", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(
      join(root, "src/a.ts"),
      ["// TODO: fix this", "// FIXME(ABC-123): tracked", "// TODO see #42", "const ok = 1"].join(
        "\n",
      ),
    );
    const { untracked } = scan(ctx);
    expect(untracked).toHaveLength(1);
    expect(untracked[0]?.line).toBe(1);
    expect(untracked[0]?.marker).toBe("TODO");
  });

  it("treats a URL and a Linear-style id as trackers", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(
      join(root, "src/a.ts"),
      ["// HACK https://example.com/x", "// XXX ABC-9 later"].join("\n"),
    );
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("silences a marker listed in the allowlist", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), "// TODO untracked\n");
    writeFileSync(join(root, "allow.json"), JSON.stringify({ allowlist: ["src/a.ts:1"] }));
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("reports stale allowlist entries", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), "const clean = 1\n");
    writeFileSync(join(root, "allow.json"), JSON.stringify({ allowlist: ["src/a.ts:1"] }));
    expect(scan(ctx).staleAllowlistEntries).toEqual(["src/a.ts:1"]);
  });

  it("seeds every current untracked marker", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), ["// TODO one", "// FIXME two"].join("\n"));
    expect(seedAllowlist(ctx)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
  });
});

describe("parseAllowlist", () => {
  it("rejects a malformed entry", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-gates-debt-"));
    const p = join(root, "allow.json");
    writeFileSync(p, JSON.stringify({ allowlist: ["no-line-number"] }));
    expect(() => parseAllowlist(p)).toThrow();
  });
});
