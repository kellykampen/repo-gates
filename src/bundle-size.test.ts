import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// Several tests silence console.error to capture it. Restoring inline only
// covers the happy path: if the call under test throws, or an assertion
// between the mock and the restore fails, the mock leaks into every later
// test in the file and swallows its diagnostic output.
afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(logicalChunkName("chunk-abc.js")).toBe("chunk-abc.js"); // segment is 3
    expect(logicalChunkName("polyfills-legacy.js")).toBe("polyfills-legacy.js"); // "legacy" is 6
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
    // Code-unit order, not collation: "ProjectArea" precedes "index" because
    // 'P' is 0x50 and 'i' is 0x69. Asserting the exact order is deliberate —
    // it pins the output as stable across Node builds with and without full
    // ICU data, which `localeCompare` would not be.
    expect(dupes.map((d) => `${d.bucket}:${d.logical}`)).toEqual([
      "css:styles.css",
      "js:ProjectArea.js",
      "js:index.js",
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
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    const exit = runBundleSize(ctx, false, { clean: cleanDist, build: restoringBuild(dist) });

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

describe("runBundleSize empty measurement", () => {
  it("fails when the build emitted nothing, instead of passing a zero-size ratchet", () => {
    // Cleaning dist first means a build that produces no output leaves an empty
    // directory — and every ratchet compares `actual > cap`, so zero passes
    // everything. Without this guard a broken build reports "guard ok".
    const { ctx, root } = makeBundleCtx();
    writeFileSync(
      join(root, "budgets.json"),
      JSON.stringify({
        web: { totals: { raw: { js: 1, css: 1 }, gzip: { js: 1, css: 1 } }, largest: { gzip: { js: 1, css: 1 } } },
      }),
    );

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    const exit = runBundleSize(ctx, false, { clean: cleanDist, build: () => 0 });

    expect(exit).toBe(1);
    expect(errors.join("\n")).toMatch(/holds no files matching/);
  });

  it("fails the same way under --init, rather than seeding a budget of pure headroom", () => {
    const { ctx, root } = makeBundleCtx();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = runBundleSize(ctx, true, { clean: cleanDist, build: () => 0 });

    expect(exit).toBe(1);
    expect(existsSync(join(root, "budgets.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gaps found by independent verification of the first commit.
// ---------------------------------------------------------------------------

describe("logicalChunkName does not mistake words for hashes", () => {
  // Every one of these was WRONGLY collapsed by the first implementation,
  // which tested only the shape of the trailing segment and not its content.
  it.each([
    "react-markdown.js",
    "react-dropdown.js",
    "auth-provider.js",
    "theme-provider.js",
    "use-debounce.js",
    "use-callback.js",
    "i18n-messages.js",
    "styles-critical.css",
  ])("leaves %s alone", (name) => {
    expect(logicalChunkName(name)).toBe(name);
  });

  it("keeps a capitalised word on the word side of the line", () => {
    // One capital is a word; two or more is a hash. `Provider` must not read
    // as a digest just because it is capitalised.
    expect(logicalChunkName("theme-Provider.js")).toBe("theme-Provider.js");
  });

  it("still strips genuine digests, including the awkward real ones", () => {
    // No digit, no lowercase, leading and trailing dashes, underscores —
    // all observed in real Rollup output.
    expect(logicalChunkName("index--GMgTQRt.js")).toBe("index.js");
    expect(logicalChunkName("index-CEyAyFk-.js")).toBe("index.js");
    expect(logicalChunkName("icons-B2W0H_8K.js")).toBe("icons.js");
    expect(logicalChunkName("prosemirror-llO5iolO.js")).toBe("prosemirror.js");
  });

  it.each([
    ["index-AbCdefg.js", 7],
    ["index-AbCdefghi.js", 9],
  ])("leaves %s alone — %i characters is not the hash width", (name) => {
    // Both carry two capitals, so `looksLikeHash` would admit the segment
    // happily; only the WIDTH rule keeps these intact. That makes each one a
    // pin on a single side of `{8}`, which is otherwise untested in both
    // directions — widening to {7,8} or {8,9} left the whole suite green.
    //
    // The two cases above look like they cover this and do not: "abc" is 3,
    // nowhere near the edge, and "legacy" is 6, so both sit on the same side.
    expect(logicalChunkName(name)).toBe(name);
  });

  it("accepts a digest at the two-capital boundary", () => {
    // Exactly two capitals, no digit — the minimum the rule admits, and about
    // 2.6% of real digests. Without this, the threshold could be raised to
    // three and nothing would notice.
    expect(logicalChunkName("index-AbCdefgh.js")).toBe("index.js");
  });

  it("accepts a long hex digest that the other arms would reject", () => {
    // All a-f, no digit, no capitals: only the long-hex arm admits it.
    expect(logicalChunkName("framework-abcdefabcdefabcd.js")).toBe("framework.js");
  });

  it("accepts a digit-bearing digest that carries no capitals at all", () => {
    // `a1b2c3d4` has zero uppercase letters, so the capital-count rule alone
    // would reject it. Only the digit arm admits it — and no English word used
    // as a chunk name contains digits.
    expect(logicalChunkName("main-a1b2c3d4.js")).toBe("main.js");
    expect(logicalChunkName("vendor-0f8e7d6c.js")).toBe("vendor.js");
  });
});

describe("findDuplicateChunks is directory-aware", () => {
  it("does not pair the same filename across a dual-format build", () => {
    // dist/esm/x.js + dist/cjs/x.js is the normal shape of a library build,
    // not one chunk emitted twice. `measure` records only basenames, so
    // without directory qualification these collide.
    const dir = mkdtempSync(join(tmpdir(), "rg-dual-"));
    writeBuild(join(dir, "esm"), { "ProjectArea-DWbILnNi.js": 400 });
    writeBuild(join(dir, "cjs"), { "ProjectArea-LeWXd_sH.js": 400 });

    expect(findDuplicateChunks(measure(dir, BUCKETS))).toEqual([]);
  });

  it("still pairs two builds layered in the SAME directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-same-"));
    writeBuild(join(dir, "esm"), {
      "ProjectArea-DWbILnNi.js": 400,
      "ProjectArea-LeWXd_sH.js": 400,
    });

    const dupes = findDuplicateChunks(measure(dir, BUCKETS));
    expect(dupes.map((d) => d.logical)).toEqual(["esm/ProjectArea.js"]);
  });

  it("does not pair an unhashed entry with a hashed chunk of the same stem", () => {
    // A build that emits an unhashed entry alongside hashed chunks is ordinary.
    // `index.js` strips to itself, so without the early-continue it would join
    // `index-CEyAyFk-.js`'s group and be reported as the same chunk twice.
    const dir = mkdtempSync(join(tmpdir(), "rg-unhashed-"));
    writeBuild(dir, { "index.js": 100, "index-CEyAyFk-.js": 1000 });

    expect(findDuplicateChunks(measure(dir, BUCKETS))).toEqual([]);
  });
});

describe("--init refuses at the boundary, not just in bulk", () => {
  it("refuses a dist holding exactly ONE duplicated chunk", () => {
    // The minimal realistic pollution. A fixture with several duplicate groups
    // cannot tell `> 0` from `> 1`.
    const { ctx, root, dist } = makeBundleCtx();
    const exit = runBundleSize(ctx, true, {
      clean: () => {},
      build: () => {
        writeBuild(dist, { "index-CEyAyFk-.js": 1000, "ProjectArea-DWbILnNi.js": 400 });
        writeBuild(dist, { "index-CiJes0HC.js": 1000 });
        return 0;
      },
    });

    expect(exit).toBe(1);
    expect(existsSync(join(root, "budgets.json"))).toBe(false);
  });
});

describe("findDuplicateChunks output order", () => {
  it("sorts files within a group regardless of the order they arrive in", () => {
    // Built by hand rather than from disk on purpose: macOS APFS returns
    // readdir entries already sorted, so a fixture written through `measure`
    // cannot observe this sort at all. Linux ext4 hashes dirents and returns
    // them in effectively arbitrary order, which is where the guard's output
    // would otherwise vary run to run — including in CI.
    const m: Measurement = {
      buckets: { js: { raw: 800, gzip: 400, largest: 200 } },
      files: [
        { name: "ProjectArea-LeWXd_sH.js", dir: "", bucket: "js", raw: 400, gzip: 200 },
        { name: "ProjectArea-DWbILnNi.js", dir: "", bucket: "js", raw: 400, gzip: 200 },
      ],
    };

    expect(findDuplicateChunks(m)[0]?.files.map((f) => f.name)).toEqual([
      "ProjectArea-DWbILnNi.js",
      "ProjectArea-LeWXd_sH.js",
    ]);
  });
});

describe("assertSafeDistDir containment", () => {
  it("refuses a sibling directory whose path merely prefixes the repo root", () => {
    // `<base>/repo` vs `<base>/repoEVIL`: a containment test of
    // `startsWith(root)` without the separator accepts the second.
    //
    // Both directories must genuinely exist. With non-existent paths the root
    // is left unresolved while the target is resolved through its deepest
    // existing ancestor, and on macOS that alone (/tmp -> /private/tmp) makes
    // the two disagree — so the assertion would pass without exercising the
    // separator at all.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-sibling-")));
    const root = join(base, "repo");
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(base, "repoEVIL", "dist"), { recursive: true });

    expect(assertSafeDistDir("dist", root)).toBe(join(root, "dist")); // control
    expect(() => assertSafeDistDir("../repoEVIL/dist", root)).toThrow(/Refusing to remove/);
  });

  it("refuses a path that leaves the repo THROUGH a symlink", () => {
    // resolve() is purely lexical, so the string looks contained while rmSync
    // would follow the link straight out of the tree.
    // Both realpath'd, for the same reason the sibling-prefix test above needs
    // it: assertSafeDistDir realpaths the root internally, so an unresolved
    // /var root would disagree with a /private/var target and the assertion
    // would pass on the mount-point mismatch rather than on the symlink —
    // green even with the symlink resolution removed entirely.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rg-root-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "rg-outside-")));
    mkdirSync(join(outside, "dist"), { recursive: true });
    writeFileSync(join(outside, "dist", "VICTIM.txt"), "do not delete me");
    symlinkSync(outside, join(root, "linkdir"));

    expect(() => assertSafeDistDir("linkdir/dist", root)).toThrow(/Refusing to remove/);
    expect(() => cleanDist("linkdir/dist", root)).toThrow(/Refusing to remove/);
    expect(existsSync(join(outside, "dist", "VICTIM.txt"))).toBe(true);
  });

  it("still accepts an ordinary path whose parents do not exist yet", () => {
    // The dist dir is normally absent on a first run; walking up to the
    // deepest existing ancestor must not turn that into a refusal.
    const root = mkdtempSync(join(tmpdir(), "rg-fresh-"));
    expect(assertSafeDistDir("apps/web/dist", root)).toBe(join(realpathSync(root), "apps/web/dist"));
  });

  it("unlinks a symlinked dist dir without touching its target", () => {
    // The FINAL component is deliberately left unresolved: rmSync removes the
    // link, and whatever it pointed at survives.
    const root = mkdtempSync(join(tmpdir(), "rg-linkdist-"));
    const target = mkdtempSync(join(tmpdir(), "rg-target-"));
    writeFileSync(join(target, "keep.txt"), "keep");
    symlinkSync(target, join(root, "dist"));

    cleanDist("dist", root);
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });
});

describe("--init refusal output", () => {
  it("lists the first five duplicates and says how many it withheld", () => {
    const { ctx, dist } = makeBundleCtx();
    const first: Record<string, number> = {};
    const second: Record<string, number> = {};
    for (let i = 0; i < 7; i += 1) {
      first[`Chunk${i}-DWbILnNi.js`] = 100;
      second[`Chunk${i}-LeWXd_sH.js`] = 100;
    }

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    runBundleSize(ctx, true, {
      clean: () => {},
      build: () => {
        writeBuild(dist, first);
        writeBuild(dist, second);
        return 0;
      },
    });

    const message = errors.join("\n");
    expect(message).toContain("7 chunk(s) emitted more than once");
    // Five listed, two withheld — the count must describe what was actually cut.
    expect(message.match(/^ {2}Chunk\d\.js:/gm)).toHaveLength(5);
    expect(message).toContain("… and 2 more");
  });
});
