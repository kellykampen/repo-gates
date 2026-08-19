import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import {
  assertSafeDistDir,
  cleanDist,
  diff,
  findDuplicateChunks,
  fmtBytes,
  loadBudgets,
  logicalChunkName,
  measure,
  runBundleSize,
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

// ---------------------------------------------------------------------------
// Stale-dist pollution (see the module docblock).
//
// A build tool empties its own output dir, but a cache hit skips the tool and
// restores cached outputs *into* whatever is already there. Two builds' chunks
// then coexist and the guard counts both.
// ---------------------------------------------------------------------------

/** One build's output: hash-suffixed chunk names, as Vite/Rollup emit them. */
const BUILD_X = {
  "index-CEyAyFk-.js": 1000,
  "ProjectArea-DWbILnNi.js": 400,
  "styles-BhK2p0Qa.css": 200,
};
/** The same chunk graph rebuilt. Sizes are identical and hashes are not —
 *  what differs is the fixed-length hash inside each import specifier. */
const BUILD_Y = {
  "index-CiJes0HC.js": 1000,
  "ProjectArea-LeWXd_sH.js": 400,
  "styles-Dq81mLxV.css": 200,
};

function writeBuild(dir: string, build: Record<string, number>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, size] of Object.entries(build)) {
    writeFileSync(join(dir, name), "x".repeat(size));
  }
}

function makeBundleCtx(distDir = "dist"): { ctx: Ctx; root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "repo-gates-bundle-"));
  const ctx: Ctx = {
    repoRoot: root,
    config: {
      ...DEFAULT_CONFIG,
      bundleSize: {
        budgetsPath: "budgets.json",
        targets: [{ name: "web", filter: "@app/web", distDir, buckets: BUCKETS }],
      },
    },
  };
  return { ctx, root, dist: join(root, distDir) };
}

/** Stands in for `turbo run build` restoring a cache hit: it writes BUILD_X's
 *  files and, like a cache restore, never removes anything already present. */
function restoringBuild(dist: string): (ctx: Ctx) => number {
  return () => {
    writeBuild(dist, BUILD_X);
    return 0;
  };
}

describe("logicalChunkName", () => {
  it("strips a trailing content hash", () => {
    expect(logicalChunkName("ProjectArea-DWbILnNi.js")).toBe("ProjectArea.js");
    expect(logicalChunkName("index-CEyAyFk-.js")).toBe("index.js");
    expect(logicalChunkName("styles-BhK2p0Qa.css")).toBe("styles.css");
  });

  it("strips a long hex digest too", () => {
    expect(logicalChunkName("main-9f2c1ab7d4e60853.js")).toBe("main.js");
  });

  it("leaves names without a hash suffix alone", () => {
    // A hyphenated package name must not be mistaken for name + hash, or two
    // unrelated chunks would collapse to the same logical name, be reported as
    // duplicates, and the guard would refuse to seed a perfectly clean dist.
    expect(logicalChunkName("use-callback-ref.js")).toBe("use-callback-ref.js");
    expect(logicalChunkName("use-sync-store.js")).toBe("use-sync-store.js");
    expect(logicalChunkName("index.js")).toBe("index.js");
    expect(logicalChunkName("chunk-abc.js")).toBe("chunk-abc.js"); // segment < 8
    expect(logicalChunkName("polyfills-legacy.js")).toBe("polyfills-legacy.js"); // segment > 8
  });
});

describe("findDuplicateChunks", () => {
  it("reports nothing for a single build's output", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-dup-clean-"));
    writeBuild(dir, BUILD_X);
    expect(findDuplicateChunks(measure(dir, BUCKETS))).toEqual([]);
  });

  it("pairs the same chunk emitted under two hashes, per bucket", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-dup-dirty-"));
    writeBuild(dir, BUILD_X);
    writeBuild(dir, BUILD_Y);

    const dupes = findDuplicateChunks(measure(dir, BUCKETS));
    expect(dupes.map((d) => `${d.bucket}:${d.logical}`)).toEqual([
      "css:styles.css",
      "js:index.js",
      "js:ProjectArea.js",
    ]);
    const projectArea = dupes.find((d) => d.logical === "ProjectArea.js");
    expect(projectArea?.files.map((f) => f.name)).toEqual([
      "ProjectArea-DWbILnNi.js",
      "ProjectArea-LeWXd_sH.js",
    ]);
    // Identical sizes are the fingerprint, not a coincidence to filter out.
    expect(new Set(projectArea?.files.map((f) => f.raw))).toEqual(new Set([400]));
  });
});

describe("assertSafeDistDir", () => {
  it("resolves a directory inside the repo", () => {
    expect(assertSafeDistDir("apps/web/dist", "/repo")).toBe("/repo/apps/web/dist");
  });

  it.each([".", "", "..", "../elsewhere", "/etc"])(
    "refuses %j, which would delete at or above the repo root",
    (bad) => {
      expect(() => assertSafeDistDir(bad, "/repo")).toThrow(/Refusing to remove/);
    },
  );
});

describe("cleanDist", () => {
  it("removes the directory and tolerates it already being gone", () => {
    const { root, dist } = makeBundleCtx();
    writeBuild(dist, BUILD_X);
    expect(existsSync(dist)).toBe(true);

    cleanDist("dist", root);
    expect(existsSync(dist)).toBe(false);
    expect(() => cleanDist("dist", root)).not.toThrow();
  });

  it("deletes nothing when the path is unsafe", () => {
    const { root } = makeBundleCtx();
    writeFileSync(join(root, "keep.txt"), "keep");

    expect(() => cleanDist(".", root)).toThrow(/Refusing to remove/);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
  });
});

describe("runBundleSize dist hygiene", () => {
  it("cleans every target before building, never after", () => {
    const { ctx, dist } = makeBundleCtx();
    const calls: string[] = [];

    runBundleSize(
      ctx,
      true,
      {
        clean: (d, r) => {
          calls.push(`clean:${d}`);
          cleanDist(d, r);
        },
        build: () => {
          calls.push("build");
          writeBuild(dist, BUILD_X);
          return 0;
        },
      },
    );

    expect(calls).toEqual(["clean:dist", "build"]);
  });

  it("measures a layered dist identically to a clean one", () => {
    // The acceptance criterion: a build layered over an existing dist must
    // report the same totals as a build into an empty one.
    const seed = (prePolluted: boolean): TargetBudget => {
      const { ctx, root, dist } = makeBundleCtx();
      if (prePolluted) writeBuild(dist, BUILD_Y); // a previous build's chunks
      const exit = runBundleSize(ctx, true, {
        clean: cleanDist,
        build: restoringBuild(dist),
      });
      expect(exit).toBe(0);
      return JSON.parse(readFileSync(join(root, "budgets.json"), "utf8")).web as TargetBudget;
    };

    expect(seed(true)).toEqual(seed(false));

    // Positive control: with the clean step removed, a stale chunk survives the
    // build and inflates the budget. Without this the assertion above would
    // pass just as well if `runBundleSize` never measured anything at all.
    //
    // The stale file is a chunk a refactor DELETED, so its name is unique and
    // no duplicate pair forms — this isolates the clean step from the --init
    // duplicate refusal, which would otherwise reject the measurement first
    // and leave nothing to compare.
    const { ctx, root, dist } = makeBundleCtx();
    writeBuild(dist, { "RemovedRoute-Ab12Cd34.js": 700 });
    const exit = runBundleSize(ctx, true, { clean: () => {}, build: restoringBuild(dist) });
    expect(exit).toBe(0);

    const polluted = JSON.parse(readFileSync(join(root, "budgets.json"), "utf8"))
      .web as TargetBudget;
    expect(polluted.totals.raw.js).toBe(seed(false).totals.raw.js + 700);
  });
});

describe("runBundleSize --init refuses a polluted measurement", () => {
  it("exits non-zero and writes no budget when a chunk appears twice", () => {
    const { ctx, root, dist } = makeBundleCtx();
    const budgets = join(root, "budgets.json");

    // A build that leaves BOTH builds' chunks behind — what a cache restore
    // into a dirty directory produces, and what --init must not seed from.
    const exit = runBundleSize(ctx, true, {
      clean: () => {},
      build: () => {
        writeBuild(dist, BUILD_Y);
        writeBuild(dist, BUILD_X);
        return 0;
      },
    });

    expect(exit).toBe(1);
    expect(existsSync(budgets)).toBe(false);
  });

  it("seeds normally when the same build is not doubled up", () => {
    const { ctx, root, dist } = makeBundleCtx();
    const exit = runBundleSize(ctx, true, { clean: cleanDist, build: restoringBuild(dist) });

    expect(exit).toBe(0);
    expect(existsSync(join(root, "budgets.json"))).toBe(true);
  });
});

describe("runBundleSize failure message", () => {
  it("tells the reader to verify the measurement before re-baselining", () => {
    const { ctx, root, dist } = makeBundleCtx();
    // A budget of 1 byte per bucket, so any real output breaches it.
    writeFileSync(
      join(root, "budgets.json"),
      JSON.stringify({
        web: { totals: { raw: { js: 1, css: 1 }, gzip: { js: 1, css: 1 } }, largest: { gzip: { js: 1, css: 1 } } },
      }),
    );

    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    const exit = runBundleSize(ctx, false, { clean: cleanDist, build: restoringBuild(dist) });
    spy.mockRestore();

    expect(exit).toBe(1);
    const message = errors.join("\n");

    // The advice must still be reachable — the point is to qualify it, not drop it.
    expect(message).toContain("--init");
    // …and the qualification must name what makes a re-baseline unsafe: the
    // ratchet is one-way, so a budget seeded from a bad measurement is not
    // something a later run can detect and correct.
    expect(message).toMatch(/confirm the growth is real/i);
    expect(message).toMatch(/ratchet only goes DOWN/i);

    // Guard against the caveat drifting apart from the advice it qualifies:
    // advice that appears BEFORE its warning is advice most readers act on.
    expect(message.indexOf("confirm the growth is real")).toBeLessThan(message.indexOf("--init"));
  });
});
