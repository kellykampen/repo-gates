import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "./config.ts";

describe("mergeConfig", () => {
  it("returns defaults when overlay is empty", () => {
    expect(mergeConfig(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
  });

  it("replaces scalars and arrays wholesale", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { runner: "bun run", scanRoots: ["lib"] });
    expect(merged.runner).toBe("bun run");
    expect(merged.scanRoots).toEqual(["lib"]);
  });

  it("merges object sections key-by-key", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { fileSize: { threshold: 800 } });
    expect(merged.fileSize.threshold).toBe(800);
    // budgetsPath is untouched
    expect(merged.fileSize.budgetsPath).toBe(DEFAULT_CONFIG.fileSize.budgetsPath);
  });
});

describe("loadConfig", () => {
  it("falls back to defaults with no config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-gates-cfg-"));
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it("overlays a repo-gates.config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-gates-cfg-"));
    writeFileSync(join(dir, "repo-gates.config.json"), JSON.stringify({ runner: "bun run" }));
    expect(loadConfig(dir).runner).toBe("bun run");
  });
});
