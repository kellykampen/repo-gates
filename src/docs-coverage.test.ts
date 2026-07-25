import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type Ctx } from "./config.ts";
import {
  escapeHatch,
  escapeWorkflowCommand,
  evaluate,
  fetchChangedFiles,
  globToRegExp,
  hasDocsChange,
  readDocsCoverageConfig,
  runDocsCoverage,
  stripFencedCode,
  triggeredSurfaces,
  type ChangedFile,
  type DocsCoverageConfig,
} from "./docs-coverage.ts";

const config: DocsCoverageConfig = {
  docsGlobs: ["apps/docs/content/docs/**"],
  surfaces: [
    { label: "HTTP API endpoints", glob: "packages/backend/convex/**/http.ts", on: "changed" },
    { label: "control-plane contract", glob: "packages/control-plane/src/**/*.ts", on: "added" },
    { label: "web feature", glob: "apps/web/src/**/*.tsx", on: "added" },
  ],
  exclude: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "apps/web/src/components/**"],
};

const f = (filename: string, status: string): ChangedFile => ({ filename, status });
const HTTP = "packages/backend/convex/github/http.ts";
const CP = "packages/control-plane/src/mcp.ts";
const WEB = "apps/web/src/cloud/NewFeature.tsx";
const DOC = "apps/docs/content/docs/api/webhooks.mdx";

describe("globToRegExp", () => {
  it("* stays within a segment", () => expect(globToRegExp("a/*.ts").test("a/b.ts")).toBe(true));
  it("* does not cross a segment", () =>
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false));
  it("** crosses segments", () => expect(globToRegExp("a/**/*.ts").test("a/b/c/d.ts")).toBe(true));
  it("**/ spans zero dirs", () => expect(globToRegExp("a/**/*.ts").test("a/d.ts")).toBe(true));
  it("trailing ** matches a subtree", () =>
    expect(globToRegExp("docs/**").test("docs/x/y.mdx")).toBe(true));
  it("dot is literal", () => expect(globToRegExp("a/b.ts").test("a/bXts")).toBe(false));
});

describe("triggeredSurfaces", () => {
  it("honors on: changed", () => {
    expect(triggeredSurfaces([f(HTTP, "modified")], config)).toHaveLength(1);
  });
  it("honors on: added — modified does not trigger", () => {
    expect(triggeredSurfaces([f(CP, "added")], config)).toHaveLength(1);
    expect(triggeredSurfaces([f(CP, "modified")], config)).toHaveLength(0);
  });
  it("excludes a test file under a surface glob", () => {
    expect(
      triggeredSurfaces([f("packages/control-plane/src/mcp.test.ts", "added")], config),
    ).toHaveLength(0);
  });
  it("excludes a shared web component", () => {
    expect(
      triggeredSurfaces([f("apps/web/src/components/Button.tsx", "added")], config),
    ).toHaveLength(0);
  });
});

describe("evaluate", () => {
  it("no surface -> skip", () => {
    expect(evaluate([f("README.md", "modified")], "", config).status).toBe("skip");
  });
  it("surface + docs -> pass", () => {
    expect(evaluate([f(HTTP, "modified"), f(DOC, "added")], "", config).status).toBe("pass");
  });
  it("surface, no docs, no hatch -> fail", () => {
    expect(evaluate([f(HTTP, "modified")], "some body", config).status).toBe("fail");
  });
  it("surface, no docs, hatch -> waived, captures reason", () => {
    const result = evaluate([f(HTTP, "modified")], "docs: n/a - internal-only", config);
    expect(result.status).toBe("waived");
    expect(result.status === "waived" && result.reason).toBe("internal-only");
  });
  it("removed docs do not count as a docs change", () => {
    expect(evaluate([f(HTTP, "modified"), f(DOC, "removed")], "", config).status).toBe("fail");
  });
  it("WEB surface added without docs fails", () => {
    expect(evaluate([f(WEB, "added")], "", config).status).toBe("fail");
  });
});

describe("hasDocsChange", () => {
  it("removed docs don't count", () => {
    expect(hasDocsChange([f(DOC, "removed")], config)).toBe(false);
  });
  it("added docs count", () => {
    expect(hasDocsChange([f(DOC, "added")], config)).toBe(true);
  });
});

describe("escapeHatch", () => {
  it("plain n/a", () => expect(escapeHatch("docs: n/a").present).toBe(true));
  it("na without slash", () => expect(escapeHatch("docs: na - reason").present).toBe(true));
  it("with list marker", () => expect(escapeHatch("- docs: n/a - because").present).toBe(true));
  it("absent", () => expect(escapeHatch("this PR adds docs later").present).toBe(false));
  it("inside a code fence is ignored", () =>
    expect(escapeHatch("```\ndocs: n/a\n```").present).toBe(false));
});

describe("escapeWorkflowCommand", () => {
  it("percent-encodes %, \\r, and \\n", () => {
    expect(escapeWorkflowCommand("100% done\r\nnext line")).toBe("100%25 done%0D%0Anext line");
  });
  it("leaves ordinary text untouched", () => {
    expect(escapeWorkflowCommand("plain text")).toBe("plain text");
  });
});

describe("stripFencedCode", () => {
  it("removes a fenced block", () => {
    expect(stripFencedCode("before\n```\ndocs: n/a\n```\nafter")).toBe("before\n\nafter");
  });
});

describe("fetchChangedFiles", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("paginates until a short page", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified" })),
      [{ filename: "last.ts", status: "added" }],
    ];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      const body = pages[call++];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const files = await fetchChangedFiles({ repo: "acme/x", number: "1", token: "t" });
    expect(files).toHaveLength(101);
    expect(files.at(-1)).toEqual({ filename: "last.ts", status: "added" });
  });

  it("throws on a non-ok response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(fetchChangedFiles({ repo: "acme/x", number: "1", token: "t" })).rejects.toThrow(
      /403/,
    );
  });
});

describe("runDocsCoverage", () => {
  function ctxWith(docsCoverage: DocsCoverageConfig): Ctx {
    return { repoRoot: "/tmp", config: { ...DEFAULT_CONFIG, docsCoverage } };
  }

  const ENV_KEYS = ["GITHUB_REPOSITORY", "PR_NUMBER", "GITHUB_TOKEN", "PR_BODY"] as const;
  const saved: Record<string, string | undefined> = {};

  function withPrEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = originalFetch;
  });

  function mockFiles(files: ChangedFile[]): void {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(files), { status: 200 }),
    ) as unknown as typeof fetch;
  }

  it("no-ops when no surfaces are configured", async () => {
    const code = await runDocsCoverage(ctxWith({ docsGlobs: [], surfaces: [], exclude: [] }));
    expect(code).toBe(0);
  });

  it("no-ops outside a PR context even with surfaces configured", async () => {
    withPrEnv({});
    const code = await runDocsCoverage(ctxWith(config));
    expect(code).toBe(0);
  });

  it("rejects a non-numeric PR_NUMBER", async () => {
    withPrEnv({ GITHUB_REPOSITORY: "acme/x", PR_NUMBER: "abc", GITHUB_TOKEN: "t" });
    const code = await runDocsCoverage(ctxWith(config));
    expect(code).toBe(1);
  });

  it("passes when a triggered surface's PR also touches docs", async () => {
    withPrEnv({ GITHUB_REPOSITORY: "acme/x", PR_NUMBER: "1", GITHUB_TOKEN: "t" });
    mockFiles([
      { filename: HTTP, status: "modified" },
      { filename: DOC, status: "added" },
    ]);
    expect(await runDocsCoverage(ctxWith(config))).toBe(0);
  });

  it("fails when a triggered surface's PR has no docs and no escape hatch", async () => {
    withPrEnv({ GITHUB_REPOSITORY: "acme/x", PR_NUMBER: "1", GITHUB_TOKEN: "t" });
    mockFiles([{ filename: HTTP, status: "modified" }]);
    expect(await runDocsCoverage(ctxWith(config))).toBe(1);
  });

  it("passes (waived) when the PR body carries the escape hatch", async () => {
    withPrEnv({
      GITHUB_REPOSITORY: "acme/x",
      PR_NUMBER: "1",
      GITHUB_TOKEN: "t",
      PR_BODY: "docs: n/a - internal only",
    });
    mockFiles([{ filename: HTTP, status: "modified" }]);
    expect(await runDocsCoverage(ctxWith(config))).toBe(0);
  });
});

describe("readDocsCoverageConfig", () => {
  function writeConfig(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "repo-gates-docscfg-"));
    const path = join(dir, "repo-gates.config.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("defaults every field when docsCoverage is absent", () => {
    expect(readDocsCoverageConfig(writeConfig({}))).toEqual({
      docsGlobs: [],
      surfaces: [],
      exclude: [],
    });
  });

  it("defaults each field independently when docsCoverage is partial", () => {
    const result = readDocsCoverageConfig(
      writeConfig({ docsCoverage: { docsGlobs: ["docs/**"] } }),
    );
    expect(result).toEqual({ docsGlobs: ["docs/**"], surfaces: [], exclude: [] });
  });
});
