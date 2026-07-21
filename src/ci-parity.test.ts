import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeReachable,
  evaluateParity,
  extractCiInvocations,
  extractRunTargets,
} from "./ci-parity.ts";

const RUNNER = "pnpm run";

describe("extractRunTargets", () => {
  it("captures runner invocations and ignores bare subcommands", () => {
    const cmd = "pnpm install --frozen-lockfile && pnpm run lint && pnpm run check:size";
    expect(extractRunTargets(cmd, RUNNER)).toEqual(["lint", "check:size"]);
  });

  it("does not treat pnpm install as a script target", () => {
    expect(extractRunTargets("pnpm install", RUNNER)).toEqual([]);
  });

  it("captures a target wrapped by another command", () => {
    expect(extractRunTargets("xvfb-run --auto-servernum pnpm run test:e2e", RUNNER)).toEqual([
      "test:e2e",
    ]);
  });
});

describe("computeReachable", () => {
  it("follows the transitive closure of runner references", () => {
    const scripts = {
      "check:all": "node bin/check-all.ts",
      verify: "pnpm run check:all",
      lint: "oxlint && eslint .",
      "check:coverage": "pnpm run test:coverage && node bin/check-coverage.ts",
      "test:coverage": "turbo run test -- --coverage",
    };
    const reachable = computeReachable(
      scripts,
      ["lint", "check:coverage"],
      ["check:all", "verify"],
      RUNNER,
    );
    expect(reachable.has("test:coverage")).toBe(true);
    expect(reachable.has("check:all")).toBe(true);
  });
});

describe("evaluateParity", () => {
  const reachable = new Set(["lint", "typecheck", "check:coverage"]);

  it("passes when every CI invocation is reachable", () => {
    const inv = [{ workflow: "ci.yml", job: "ci", step: 1, script: "lint" }];
    expect(evaluateParity(inv, reachable, { aliases: {}, ciOnly: new Set() }, "check:all")).toEqual(
      [],
    );
  });

  it("flags an unreachable CI script", () => {
    const inv = [{ workflow: "ci.yml", job: "ci", step: 3, script: "test:e2e" }];
    const failures = evaluateParity(
      inv,
      reachable,
      { aliases: {}, ciOnly: new Set() },
      "check:all",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("not reachable");
  });

  it("respects the ciOnly allowlist and aliases", () => {
    const inv = [
      { workflow: "ci.yml", job: "ci", step: 3, script: "test:e2e" },
      { workflow: "ci.yml", job: "ci", step: 4, script: "check:coverage:ci" },
    ];
    const config = {
      aliases: { "check:coverage:ci": "check:coverage" },
      ciOnly: new Set(["test:e2e"]),
    };
    expect(evaluateParity(inv, reachable, config, "check:all")).toEqual([]);
  });
});

describe("extractCiInvocations", () => {
  it("parses run steps out of a workflow yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-gates-ci-"));
    const file = join(dir, "ci.yml");
    writeFileSync(
      file,
      [
        "jobs:",
        "  check:",
        "    steps:",
        "      - run: pnpm install",
        "      - run: pnpm run lint",
        "      - run: pnpm run typecheck",
      ].join("\n"),
    );
    const invs = extractCiInvocations(file, dir, RUNNER);
    expect(invs.map((i) => i.script)).toEqual(["lint", "typecheck"]);
    expect(invs[0]?.job).toBe("check");
  });
});
