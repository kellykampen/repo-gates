import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diff,
  fmtBytes,
  loadBudgets,
  measure,
  seedBudget,
  type Measurement,
  type TargetBudget,
} from "./bundle-size.ts";

const BUCKETS = { js: [".js"], css: [".css"] };

describe("measure", () => {
  it("aggregates raw bytes per bucket, ignores non-bucket files, recurses", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-bundle-"));
    writeFileSync(join(dir, "a.js"), "x".repeat(100));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.js"), "y".repeat(300));
    writeFileSync(join(dir, "c.css"), "z".repeat(50));
    writeFileSync(join(dir, "index.html"), "<html>"); // ignored
    writeFileSync(join(dir, "a.js.map"), "{}"); // ignored (.map, not .js)

    const m = measure(dir, BUCKETS);
    expect(m.buckets.js?.raw).toBe(400);
    expect(m.buckets.css?.raw).toBe(50);
    expect(m.files.map((f) => f.name).sort()).toEqual(["a.js", "b.js", "c.css"]);
    expect(m.buckets.js?.gzip).toBeGreaterThan(0);
  });

  it("returns zeroed buckets for a missing dist dir", () => {
    const m = measure(join(tmpdir(), "rg-does-not-exist-xyz"), BUCKETS);
    expect(m.buckets.js).toEqual({ raw: 0, gzip: 0, largest: 0 });
    expect(m.files).toEqual([]);
  });
});

const M: Measurement = {
  buckets: { js: { raw: 1000, gzip: 400, largest: 250 }, css: { raw: 200, gzip: 80, largest: 80 } },
  files: [],
};
const BUDGET: TargetBudget = {
  totals: { raw: { js: 1000, css: 200 }, gzip: { js: 400, css: 80 } },
  largest: { gzip: { js: 250, css: 80 } },
};

describe("diff", () => {
  it("passes when everything is at or under budget", () => {
    expect(diff("web", M, BUDGET)).toEqual([]);
  });

  it("flags a total and a largest-chunk regression separately", () => {
    const grown: Measurement = {
      buckets: {
        js: { raw: 1000, gzip: 401, largest: 260 },
        css: { raw: 200, gzip: 80, largest: 80 },
      },
      files: [],
    };
    const failures = diff("web", grown, BUDGET);
    expect(failures.map((f) => f.metric).sort()).toEqual(["largest.gzip", "totals.gzip"]);
    expect(failures.every((f) => f.target === "web" && f.bucket === "js")).toBe(true);
  });
});

describe("seedBudget", () => {
  it("adds headroom above the measured sizes", () => {
    const b = seedBudget(M);
    expect(b.totals.raw.js).toBe(1000 + 2048);
    expect(b.totals.gzip.js).toBe(400 + 512);
    expect(b.largest.gzip.js).toBe(250 + 512);
  });
});

describe("loadBudgets", () => {
  it("parses targets and skips comment keys", () => {
    const b = loadBudgets(JSON.stringify({ _comment: "x", web: BUDGET }));
    expect(Object.keys(b)).toEqual(["web"]);
    expect(b.web?.totals.gzip.js).toBe(400);
  });

  it("throws when a target is missing required sections", () => {
    expect(() => loadBudgets(JSON.stringify({ web: { totals: { raw: {} } } }))).toThrow();
  });
});

describe("fmtBytes", () => {
  it("formats bytes and KB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
  });
});
