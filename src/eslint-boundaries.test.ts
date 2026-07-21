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
});
