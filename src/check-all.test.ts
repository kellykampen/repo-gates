import { describe, expect, it } from "vitest";
import type { GateSpec } from "./config.ts";
import {
  extractFailureSignatures,
  extractScores,
  formatGateLine,
  formatScoresBlock,
  resolveGates,
} from "./check-all.ts";

const GATES: GateSpec[] = [
  { name: "lint", conditional: false },
  { name: "typecheck", conditional: false },
  { name: "check:deps", conditional: true },
  { name: "check:ci-parity", conditional: false },
];

describe("resolveGates", () => {
  it("keeps every core gate even when the repo does not define it", () => {
    expect(resolveGates({}, GATES)).toEqual(["lint", "typecheck", "check:ci-parity"]);
  });

  it("includes a conditional gate only when the repo defines it", () => {
    const scripts = { "check:deps": "knip" };
    expect(resolveGates(scripts, GATES)).toEqual([
      "lint",
      "typecheck",
      "check:deps",
      "check:ci-parity",
    ]);
  });

  it("preserves manifest order", () => {
    const scripts = { lint: "x", typecheck: "y", "check:deps": "z", "check:ci-parity": "w" };
    expect(resolveGates(scripts, GATES)).toEqual([
      "lint",
      "typecheck",
      "check:deps",
      "check:ci-parity",
    ]);
  });
});

describe("formatGateLine", () => {
  it("marks pass and pads to width", () => {
    expect(formatGateLine("ok", "lint", 1.23, 9)).toBe("✓ lint      (1.2s)");
  });
  it("marks failure", () => {
    expect(formatGateLine("fail", "typecheck", 0.4, 9)).toBe("✗ typecheck (0.4s)");
  });
});

describe("extractScores", () => {
  it("pulls SCORE: lines and strips the prefix", () => {
    const out = [
      "noise",
      "SCORE: coverage — lowest x 63.1% lines",
      "more",
      "SCORE: debt — 4 ok",
    ].join("\n");
    expect(extractScores(out)).toEqual(["coverage — lowest x 63.1% lines", "debt — 4 ok"]);
  });

  it("returns nothing when a gate emits no score (binary gates)", () => {
    expect(extractScores("File-size guard ok.\n")).toEqual([]);
  });
});

describe("formatScoresBlock", () => {
  it("is empty when there are no scores", () => {
    expect(formatScoresBlock([])).toEqual([]);
  });

  it("aligns labels and keeps the value (em-dashes in the value survive)", () => {
    const out = formatScoresBlock(["coverage — lowest x 63.1%", "debt — 4 ok — really"]);
    expect(out[0]).toBe("");
    expect(out[1]).toBe("Scores:");
    expect(out[2]).toBe("  coverage  lowest x 63.1%");
    expect(out[3]).toBe("  debt      4 ok — really");
  });
});

describe("extractFailureSignatures", () => {
  it("pulls tsc error lines", () => {
    const out = extractFailureSignatures("noise\nsrc/x.ts(1,1): error TS2322: bad\nmore noise");
    expect(out).toEqual(["src/x.ts(1,1): error TS2322: bad"]);
  });

  it("pulls prettier and budget signatures", () => {
    const out = extractFailureSignatures(
      ["[warn] Code style issues found in 3 files", "x below floor 90%", "ok line"].join("\n"),
    );
    expect(out).toContain("[warn] Code style issues found in 3 files");
    expect(out).toContain("x below floor 90%");
  });

  it("falls back to the non-empty tail when nothing matches", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const out = extractFailureSignatures(lines.join("\n"));
    expect(out).toHaveLength(25);
    expect(out.at(-1)).toBe("line 39");
  });
});
