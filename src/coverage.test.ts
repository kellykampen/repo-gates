import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import {
  checkPerPackage,
  collectPerPackage,
  coverageScore,
  expandGlob,
  loadBudgets,
  pkgKey,
  readSummaryCounts,
  seedBudgets,
  seedFloor,
  type Budgets,
  type PkgCoverage,
} from "./coverage.ts";

function writeSummary(root: string, pkgDir: string, functionsPct: number, linesPct: number): void {
  mkdirSync(join(root, pkgDir, "coverage"), { recursive: true });
  writeFileSync(
    join(root, pkgDir, "coverage", "coverage-summary.json"),
    JSON.stringify({
      total: {
        functions: { covered: functionsPct, total: 100 },
        lines: { covered: linesPct, total: 100 },
      },
    }),
  );
}

function ctxFor(root: string): Ctx {
  return {
    repoRoot: root,
    config: {
      ...DEFAULT_CONFIG,
      coverage: {
        budgetsPath: "coverage-budgets.json",
        summaryGlobs: ["packages/*/coverage/coverage-summary.json"],
      },
    },
  };
}

describe("pkgKey", () => {
  it("derives the package dir from a summary path", () => {
    expect(pkgKey("/repo", "/repo/apps/web/coverage/coverage-summary.json")).toBe("apps/web");
  });
});

describe("collectPerPackage", () => {
  it("returns one sorted row per matched summary", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-gates-cov-"));
    writeSummary(root, "packages/b", 80, 90);
    writeSummary(root, "packages/a", 100, 100);
    const rows = collectPerPackage(ctxFor(root));
    expect(rows.map((r) => r.pkg)).toEqual(["packages/a", "packages/b"]);
    expect(rows[1]?.totals).toEqual({ functions: 80, lines: 90 });
  });
});

describe("checkPerPackage", () => {
  const budgets: Budgets = {
    default: { functions: 80, lines: 80 },
    packages: {
      "packages/a": { functions: 95, lines: 95 },
      "packages/b": { functions: 70, lines: 70 },
    },
  };

  it("fails a package below its own floor and names it", () => {
    const perPkg: PkgCoverage[] = [{ pkg: "packages/a", totals: { functions: 90, lines: 99 } }];
    const { failures } = checkPerPackage(perPkg, budgets);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ pkg: "packages/a", metric: "functions", floor: 95 });
  });

  it("does not let a high package mask a low one (no aggregation)", () => {
    const perPkg: PkgCoverage[] = [
      { pkg: "packages/a", totals: { functions: 100, lines: 100 } }, // way over
      { pkg: "packages/b", totals: { functions: 60, lines: 60 } }, // under its 70 floor
    ];
    const { failures } = checkPerPackage(perPkg, budgets);
    expect(failures.map((f) => f.pkg)).toEqual(["packages/b", "packages/b"]);
  });

  it("holds a new (unlisted) package to the default and flags it", () => {
    const perPkg: PkgCoverage[] = [{ pkg: "packages/new", totals: { functions: 75, lines: 85 } }];
    const { failures, newPkgs } = checkPerPackage(perPkg, budgets);
    expect(newPkgs).toEqual(["packages/new"]);
    expect(failures).toHaveLength(1); // functions 75 < default 80; lines 85 >= 80
    expect(failures[0]).toMatchObject({ metric: "functions", isNew: true });
  });

  it("reports a stale budget entry with no summary", () => {
    const perPkg: PkgCoverage[] = [{ pkg: "packages/a", totals: { functions: 99, lines: 99 } }];
    const { stale } = checkPerPackage(perPkg, budgets);
    expect(stale).toEqual(["packages/b"]);
  });

  describe("partial runs", () => {
    // A partial run happens when CI scopes coverage to the packages a pull request affected.
    // Every unaffected package then has no summary, which the full-run path calls stale.
    const perPkg: PkgCoverage[] = [{ pkg: "packages/a", totals: { functions: 99, lines: 99 } }];

    it("treats an unrun package as held, not stale, when its directory still exists", () => {
      const { stale, notRun } = checkPerPackage(perPkg, budgets, {
        partial: true,
        packageExists: () => true,
      });
      expect(stale).toEqual([]);
      expect(notRun).toEqual(["packages/b"]);
    });

    it("STILL reports a deleted package as stale in partial mode", () => {
      // The load-bearing case. If --partial simply disabled the stale check it would become a
      // way to hide dead floors, and CI would pass that flag on every run. The flag has to
      // narrow the check, not remove it: absence is excused only for a package still on disk.
      const { stale, notRun } = checkPerPackage(perPkg, budgets, {
        partial: true,
        packageExists: (pkg) => pkg !== "packages/b",
      });
      expect(stale).toEqual(["packages/b"]);
      expect(notRun).toEqual([]);
    });

    it("distinguishes the two in one run", () => {
      const mixed = { ...budgets, packages: { ...budgets.packages, "packages/gone": budgets.default } };
      const { stale, notRun } = checkPerPackage(perPkg, mixed, {
        partial: true,
        packageExists: (pkg) => pkg !== "packages/gone",
      });
      expect(stale).toEqual(["packages/gone"]);
      expect(notRun).toEqual(["packages/b"]);
    });

    it("still fails an affected package that is BELOW its floor", () => {
      // Scoping changes which packages are measured, never how strictly a measured one is judged.
      const below: PkgCoverage[] = [{ pkg: "packages/b", totals: { functions: 1, lines: 1 } }];
      const { failures } = checkPerPackage(below, budgets, {
        partial: true,
        packageExists: () => true,
      });
      expect(failures.map((f) => f.pkg)).toEqual(["packages/b", "packages/b"]);
    });

    it("fails closed when partial is requested with no existence probe", () => {
      // Nothing else pins the default, and the unsafe direction is silent: an "it exists"
      // default would mark every unmatched entry as merely not-run and disable stale detection
      // for a caller who simply forgot the probe.
      const { stale, notRun } = checkPerPackage(perPkg, budgets, { partial: true });
      expect(stale).toEqual(["packages/b"]);
      expect(notRun).toEqual([]);
    });

    it("defaults to full-run behaviour when partial is not requested", () => {
      const { stale, notRun } = checkPerPackage(perPkg, budgets, { packageExists: () => true });
      expect(stale).toEqual(["packages/b"]);
      expect(notRun).toEqual([]);
    });
  });
});

describe("coverageScore", () => {
  it("names the lowest-lines package and the count", () => {
    expect(
      coverageScore([
        { pkg: "a", totals: { functions: 90, lines: 95 } },
        { pkg: "b", totals: { functions: 80, lines: 70 } },
      ]),
    ).toBe("coverage — lowest b 70.0% lines (2 pkgs ≥ floor)");
  });

  it("is undefined with no packages", () => {
    expect(coverageScore([])).toBeUndefined();
  });
});

describe("seedBudgets", () => {
  it("seeds each package 0.5pt below its measured value", () => {
    const perPkg: PkgCoverage[] = [{ pkg: "packages/a", totals: { functions: 92.7, lines: 88.2 } }];
    const budgets = seedBudgets(perPkg, { functions: 80, lines: 80 });
    expect(budgets.packages["packages/a"]).toEqual({ functions: 92.2, lines: 87.7 });
    expect(budgets.default).toEqual({ functions: 80, lines: 80 });
  });
});

describe("seedFloor", () => {
  it("sits 0.5pt below the measured value, floored to 2dp", () => {
    expect(seedFloor(92.735)).toBe(92.23);
    expect(seedFloor(0.2)).toBe(0);
  });
});

describe("loadBudgets", () => {
  it("parses default + packages", () => {
    const b = loadBudgets(
      JSON.stringify({
        default: { functions: 80, lines: 80 },
        packages: { "apps/web": { functions: 66, lines: 69 } },
      }),
    );
    expect(b.default.lines).toBe(80);
    expect(b.packages["apps/web"]).toEqual({ functions: 66, lines: 69 });
  });

  it("falls back to the 80/80 default when omitted", () => {
    expect(loadBudgets(JSON.stringify({ packages: {} })).default).toEqual({
      functions: 80,
      lines: 80,
    });
  });

  it("rejects an out-of-range percentage", () => {
    expect(() =>
      loadBudgets(JSON.stringify({ packages: { x: { functions: 120, lines: 90 } } })),
    ).toThrow();
  });
});

describe("readSummaryCounts", () => {
  it("reads the total block of a vitest json-summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-gates-cov-"));
    const p = join(dir, "coverage-summary.json");
    writeFileSync(
      p,
      JSON.stringify({
        total: {
          functions: { covered: 8, total: 10, pct: 80 },
          lines: { covered: 90, total: 100, pct: 90 },
        },
      }),
    );
    expect(readSummaryCounts(p)).toEqual({
      functions: { covered: 8, total: 10 },
      lines: { covered: 90, total: 100 },
    });
  });
});

describe("expandGlob", () => {
  it("expands a single-star segment", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-gates-glob-"));
    for (const pkg of ["a", "b"]) {
      mkdirSync(join(root, "packages", pkg, "coverage"), { recursive: true });
      writeFileSync(join(root, "packages", pkg, "coverage", "coverage-summary.json"), "{}");
    }
    const matches = expandGlob(root, "packages/*/coverage/coverage-summary.json");
    expect(matches).toHaveLength(2);
  });
});
