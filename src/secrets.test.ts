import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import { listTrackedFiles, scan, seedAllowlist } from "./secrets.ts";

function git(root: string, ...args: string[]) {
  spawnSync("git", args, { cwd: root });
}

function makeCtx(): { ctx: Ctx; root: string } {
  const root = mkdtempSync(join(tmpdir(), "repo-gates-secrets-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true });
  const ctx: Ctx = {
    repoRoot: root,
    config: { ...DEFAULT_CONFIG, secrets: { ...DEFAULT_CONFIG.secrets, allowlistPath: "allow.json" } },
  };
  return { ctx, root };
}

function track(root: string) {
  git(root, "add", "-A");
}

describe("listTrackedFiles", () => {
  it("returns tracked files, empty outside a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-gates-secrets-notgit-"));
    expect(listTrackedFiles(root)).toEqual([]);
  });

  it("lists a staged file", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-gates-secrets-git-"));
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "hi\n");
    track(root);
    expect(listTrackedFiles(root)).toEqual(["a.txt"]);
  });
});

describe("secrets scan", () => {
  it("flags an AWS access key but never prints the matched text", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
    track(root);
    const { untracked } = scan(ctx);
    expect(untracked).toHaveLength(1);
    expect(untracked[0]?.path).toBe("src/a.ts");
    expect(untracked[0]?.line).toBe(1);
    expect(untracked[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("flags a GitHub token", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), `const t = "ghp_${"a".repeat(36)}";\n`);
    track(root);
    expect(scan(ctx).untracked).toHaveLength(1);
  });

  it("flags a PEM private key header", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.pem"), "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n");
    track(root);
    expect(scan(ctx).untracked).toHaveLength(1);
  });

  it("does not flag clean source", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), "export const x = 1;\n");
    track(root);
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("skips a binary extension even if it happens to contain a match shape", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.png"), "AKIAABCDEFGHIJKLMNOP");
    track(root);
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("silences a finding listed in the allowlist", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
    track(root);
    writeFileSync(join(root, "allow.json"), JSON.stringify({ allowlist: ["src/a.ts:1"] }));
    expect(scan(ctx).untracked).toEqual([]);
  });

  it("reports a stale allowlist entry once the finding is gone", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), "export const x = 1;\n");
    track(root);
    writeFileSync(join(root, "allow.json"), JSON.stringify({ allowlist: ["src/a.ts:1"] }));
    expect(scan(ctx).staleAllowlistEntries).toEqual(["src/a.ts:1"]);
  });

  it("seeds every current finding", () => {
    const { ctx, root } = makeCtx();
    writeFileSync(join(root, "src/a.ts"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
    track(root);
    expect(seedAllowlist(ctx)).toEqual(["src/a.ts:1"]);
  });
});
