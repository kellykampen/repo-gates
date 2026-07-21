import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countLines, walk } from "./fs.ts";

describe("countLines", () => {
  it("returns 0 for an empty file", () => {
    const p = join(mkdtempSync(join(tmpdir(), "rg-fs-")), "empty.ts");
    writeFileSync(p, "");
    expect(countLines(p)).toBe(0);
  });

  it("counts newline-terminated lines", () => {
    const p = join(mkdtempSync(join(tmpdir(), "rg-fs-")), "a.ts");
    writeFileSync(p, "a\nb\n");
    expect(countLines(p)).toBe(2);
  });

  it("counts a final line with no trailing newline", () => {
    const p = join(mkdtempSync(join(tmpdir(), "rg-fs-")), "b.ts");
    writeFileSync(p, "a\nb");
    expect(countLines(p)).toBe(2);
  });
});

describe("walk", () => {
  it("yields files but does not follow symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-walk-"));
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "keep.ts"), "x\n");
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "hidden.ts"), "x\n");
    // A symlinked directory inside the tree must NOT be traversed.
    symlinkSync(join(root, "outside"), join(root, "link"));

    const files = [...walk(join(root, "real"), [])].map((f) => f.replace(root, ""));
    expect(files).toEqual(["/real/keep.ts"]);

    // Walking the whole root still skips the symlink (no outside/hidden.ts via link).
    const all = [...walk(root, [])];
    expect(all.some((f) => f.includes(`${"link"}/`))).toBe(false);
  });
});
