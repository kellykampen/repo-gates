import { describe, expect, it } from "vitest";
import { boundariesToEslintConfigs, type Boundary } from "./eslint-boundaries.ts";

describe("boundariesToEslintConfigs", () => {
  it("maps a boundary to a no-restricted-imports flat config with all its pattern groups", () => {
    const b: Boundary = {
      name: "renderer",
      files: ["apps/desktop/src/renderer/**"],
      patterns: [
        { forbid: ["node:*", "node-pty"], allowTypeImports: true, message: "no node in renderer" },
        { forbid: ["@x/web"] },
      ],
    };
    const [cfg] = boundariesToEslintConfigs([b]);
    expect(cfg?.name).toBe("repo-gates/boundary/renderer");
    expect(cfg?.files).toEqual(["apps/desktop/src/renderer/**"]);
    expect(cfg && "ignores" in cfg).toBe(false);

    const rule = cfg?.rules["@typescript-eslint/no-restricted-imports"] as [
      string,
      { patterns: unknown[] },
    ];
    expect(rule[0]).toBe("error");
    expect(rule[1].patterns).toEqual([
      { group: ["node:*", "node-pty"], allowTypeImports: true, message: "no node in renderer" },
      {
        group: ["@x/web"],
        allowTypeImports: false,
        message: 'Import boundary "renderer" violated.',
      },
    ]);
  });

  it("passes ignores through when present", () => {
    const [cfg] = boundariesToEslintConfigs([
      { name: "x", files: ["a/**"], ignores: ["**/*.test.ts"], patterns: [{ forbid: ["y"] }] },
    ]);
    expect(cfg?.ignores).toEqual(["**/*.test.ts"]);
  });

  it("returns one config per boundary, in order", () => {
    const cfgs = boundariesToEslintConfigs([
      { name: "a", files: ["a/**"], patterns: [{ forbid: ["x"] }] },
      { name: "b", files: ["b/**"], patterns: [{ forbid: ["y"] }] },
    ]);
    expect(cfgs.map((c) => c.name)).toEqual(["repo-gates/boundary/a", "repo-gates/boundary/b"]);
  });

  it("merges an extended boundary's patterns ahead of its own (inherited scope keeps its own files)", () => {
    const cfgs = boundariesToEslintConfigs([
      { name: "no-cross-app", files: ["apps/**"], patterns: [{ forbid: ["@x/web"], message: "no cross-app" }] },
      {
        name: "renderer",
        files: ["apps/desktop/src/renderer/**"],
        extends: ["no-cross-app"],
        patterns: [{ forbid: ["node:*"], allowTypeImports: true, message: "no node" }],
      },
    ]);
    const renderer = cfgs.find((c) => c.name === "repo-gates/boundary/renderer");
    expect(renderer?.files).toEqual(["apps/desktop/src/renderer/**"]); // own scope, not the parent's
    const rule = renderer?.rules["@typescript-eslint/no-restricted-imports"] as [
      string,
      { patterns: { group: string[]; message: string }[] },
    ];
    // inherited group first, then own
    expect(rule[1].patterns.map((p) => p.group)).toEqual([["@x/web"], ["node:*"]]);
    expect(rule[1].patterns.map((p) => p.message)).toEqual(["no cross-app", "no node"]);
  });

  it("resolves extends transitively", () => {
    const [, , c] = boundariesToEslintConfigs([
      { name: "a", files: ["a/**"], patterns: [{ forbid: ["x"] }] },
      { name: "b", files: ["b/**"], extends: ["a"], patterns: [{ forbid: ["y"] }] },
      { name: "c", files: ["c/**"], extends: ["b"], patterns: [{ forbid: ["z"] }] },
    ]);
    const rule = c?.rules["@typescript-eslint/no-restricted-imports"] as [string, { patterns: { group: string[] }[] }];
    expect(rule[1].patterns.map((p) => p.group)).toEqual([["x"], ["y"], ["z"]]);
  });

  it("throws on an unknown extends reference", () => {
    expect(() =>
      boundariesToEslintConfigs([{ name: "b", files: ["b/**"], extends: ["nope"], patterns: [] }]),
    ).toThrow(/extends unknown boundary "nope"/);
  });

  it("throws on a circular extends", () => {
    expect(() =>
      boundariesToEslintConfigs([
        { name: "a", files: ["a/**"], extends: ["b"], patterns: [] },
        { name: "b", files: ["b/**"], extends: ["a"], patterns: [] },
      ]),
    ).toThrow(/circular `extends`/);
  });
});
