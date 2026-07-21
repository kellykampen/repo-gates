import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import { collectTiming, formatQualityMetrics, formatTiming, parseJUnit } from "./report.ts";

const XML = `<?xml version="1.0"?>
<testsuites name="vitest" tests="2" time="1.5">
  <testsuite name="a.test.ts" file="src/a.test.ts">
    <testcase classname="a" name="fast" file="src/a.test.ts" time="0.10"/>
    <testcase classname="a" name="slow" file="src/a.test.ts" time="1.40"/>
  </testsuite>
</testsuites>`;

describe("parseJUnit", () => {
  it("extracts test cases with times", () => {
    const cases = parseJUnit(XML);
    expect(cases).toHaveLength(2);
    expect(cases[1]).toEqual({
      name: "slow",
      classname: "a",
      file: "src/a.test.ts",
      timeSeconds: 1.4,
    });
  });

  it("falls back to classname when file attr is absent", () => {
    const [c] = parseJUnit('<testcase classname="x" name="n" time="0.5"/>');
    expect(c?.file).toBe("x");
  });
});

describe("formatTiming", () => {
  it("renders a markdown table sorted slowest-first", () => {
    const out = formatTiming({ totalSeconds: 1.5, totalTests: 2, cases: parseJUnit(XML) }, 20);
    expect(out).toContain("## Test timing");
    expect(out).toContain("across 2 tests");
    // slow (1.40s) before fast (0.10s)
    expect(out.indexOf("slow")).toBeLessThan(out.indexOf("fast"));
    expect(out).toContain("| 1.40s |");
  });
});

function reportCtx(root: string): Ctx {
  return {
    repoRoot: root,
    config: {
      ...DEFAULT_CONFIG,
      report: { junitGlobs: ["packages/*/test-results/junit.xml"], topN: 20 },
    },
  };
}

describe("collectTiming", () => {
  it("merges junit across matched files", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-timing-"));
    mkdirSync(join(root, "packages", "a", "test-results"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "test-results", "junit.xml"), XML);
    const { report, files } = collectTiming(reportCtx(root));
    expect(files).toBe(1);
    expect(report.totalTests).toBe(2);
    expect(report.totalSeconds).toBeCloseTo(1.5);
  });
});

describe("formatQualityMetrics", () => {
  it("renders a table, degrading missing inputs to a dash", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-qm-"));
    const out = formatQualityMetrics(reportCtx(root));
    expect(out).toContain("## Code-quality metrics");
    expect(out).toContain("Coverage (lowest pkg)");
    expect(out).toContain("Debt markers (untracked)");
  });
});
