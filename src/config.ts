/**
 * Per-repo policy for @kellykampen/repo-gates.
 *
 * The engine is repo-agnostic; everything that varies between repos lives
 * here. A consumer repo drops a partial `repo-gates.config.json` at its
 * root; anything it omits falls back to {@link DEFAULT_CONFIG} (tuned for
 * a pnpm + turbo + vitest monorepo). The loader always resolves policy
 * relative to the *consumer* repo root (default `process.cwd()`), never
 * the package's own location — that is the whole point of extracting this
 * into a package.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GateSpec = {
  /** The package.json script name, e.g. "typecheck" or "check:size". */
  name: string;
  /** Conditional gates run only when the consumer's package.json defines
   *  them; core gates (conditional: false) must exist or the run fails. */
  conditional: boolean;
};

export type RepoGatesConfig = {
  /** How a gate script is invoked, e.g. "pnpm run" or "bun run". */
  runner: string;
  /** Ordered gate manifest — cheap gates first, the CI-parity meta-gate last. */
  gates: GateSpec[];
  /** Roots the file-size and debt-marker guards walk. */
  scanRoots: string[];
  /** Directory names pruned during scans (matched as a path segment). */
  excludeDirSegments: string[];
  /** Repo-relative posix path prefixes excluded from scans. */
  excludePathPrefixes: string[];
  /** Extensions the size/debt guards treat as source. */
  sourceExtensions: string[];
  fileSize: {
    /** Default per-file line ceiling for files without an explicit budget. */
    threshold: number;
    /** Repo-relative path to the grandfathered per-file budgets JSON. */
    budgetsPath: string;
  };
  debt: {
    /** Repo-relative path to the grandfathered untracked-marker allowlist. */
    allowlistPath: string;
    /** Marker tokens that require a tracker reference on the same line. */
    markerTokens: string[];
    /** Source strings for the RegExps that count as a "tracker reference". */
    trackerPatterns: string[];
  };
  circular: {
    /** Repo-relative path to the grandfathered circular-import allowlist. */
    allowlistPath: string;
  };
  secrets: {
    /** Repo-relative path to the grandfathered secret-finding allowlist. */
    allowlistPath: string;
    /** Source strings for the RegExps matched against every git-tracked
     *  line (well-known credential shapes — AWS/GitHub/Slack/Stripe/npm/
     *  Google API keys, PEM private-key headers). Findings are reported as
     *  a redacted fingerprint, never the matched text. */
    patterns: string[];
    /** File extensions (with the dot) skipped as binary/non-text. */
    binaryExtensions: string[];
  };
  coverage: {
    /** Repo-relative path to the coverage floor JSON. */
    budgetsPath: string;
    /** Globs (repo-relative) matching each package's vitest
     *  `coverage-summary.json`. */
    summaryGlobs: string[];
  };
  ciParity: {
    /** Repo-relative path to the parity escape-hatch config. */
    configPath: string;
    /** The root gate every CI invocation must be reachable from. */
    rootGate: string;
    /** Entry points seeded into the reachability walk alongside the gates. */
    entryGates: string[];
    /** Only workflow files whose basename starts with this are gate workflows. */
    workflowPrefix: string;
  };
  bundleSize: {
    /** Repo-relative path to the bundle-size budgets JSON. */
    budgetsPath: string;
    /** Build+measure targets. Empty → the gate is a no-op (nothing to measure). */
    targets: {
      /** Budget key + display name, e.g. "web". */
      name: string;
      /** turbo `--filter` selector to build before measuring, e.g. "@x/web". */
      filter: string;
      /** Repo-relative dir of built assets to scan (hashed filenames ok). */
      distDir: string;
      /** Bucket name → file extensions, e.g. { "js": [".js"], "css": [".css"] }. */
      buckets: Record<string, string[]>;
    }[];
  };
  report: {
    /** Globs matching per-package junit XML (report:test-timing). Empty ⇒ no-op. */
    junitGlobs: string[];
    /** How many slowest tests to list. */
    topN: number;
  };
  agents: {
    /** Repo-relative agent-doc files to validate (e.g. ["AGENTS.md"]). Empty ⇒ no-op. */
    targets: string[];
    /** Backticked paths in the docs that intentionally don't exist on disk
     *  (generated artifacts, runtime files, illustrative names). */
    knownMissingPaths: string[];
    /** Package-manager command whose script invocations are validated (e.g. "pnpm"). */
    runnerCommand: string;
    /** Subcommands of runnerCommand that are builtins, not scripts (ignored). */
    ignoredSubcommands: string[];
  };
  docsCoverage: {
    /** Globs (repo-relative) a PR must touch for a triggered surface to
     *  count as documented. Empty `surfaces` ⇒ the gate is a no-op. */
    docsGlobs: string[];
    /** User-facing surfaces that require docs when changed. */
    surfaces: {
      /** Human-readable label shown in the failure/notice output. */
      label: string;
      /** Glob matched against the PR's changed-file paths. */
      glob: string;
      /** "added" — only a brand-new file triggers; "changed" — added,
       *  modified, renamed, or copied all trigger. */
      on: "added" | "changed";
    }[];
    /** Globs removed from BOTH surface and docs matching (tests, fixtures). */
    exclude: string[];
  };
};

export const DEFAULT_CONFIG: RepoGatesConfig = {
  runner: "pnpm run",
  gates: [
    { name: "lint", conditional: false },
    { name: "format:check", conditional: false },
    { name: "typecheck", conditional: false },
    { name: "check:scripts", conditional: true },
    { name: "check:deps", conditional: true },
    { name: "check:dups", conditional: true },
    { name: "check:size", conditional: false },
    { name: "check:debt", conditional: false },
    { name: "check:circular", conditional: true },
    { name: "check:secrets", conditional: true },
    { name: "check:agents", conditional: true },
    { name: "check:shadscan", conditional: true },
    { name: "check:docs-coverage", conditional: true },
    { name: "check:bundle-size", conditional: true },
    { name: "test", conditional: false },
    { name: "check:coverage", conditional: true },
    { name: "check:ci-parity", conditional: false },
  ],
  scanRoots: ["apps", "packages", "scripts"],
  excludeDirSegments: [
    "node_modules",
    "dist",
    "dist-e2e",
    "out",
    ".turbo",
    ".wrangler",
    "__golden__",
    "_generated",
    "coverage",
  ],
  excludePathPrefixes: [],
  sourceExtensions: [".ts", ".tsx"],
  fileSize: { threshold: 600, budgetsPath: "gates/file-size-budgets.json" },
  debt: {
    allowlistPath: "gates/debt-marker-allowlist.json",
    markerTokens: ["TODO", "FIXME", "HACK", "XXX"],
    trackerPatterns: ["\\b[A-Z]{2,}-\\d+\\b", "#\\d+\\b", "https?:\\/\\/\\S+"],
  },
  circular: { allowlistPath: "gates/circular-imports-allowlist.json" },
  secrets: {
    allowlistPath: "gates/secrets-allowlist.json",
    patterns: [
      "\\bAKIA[0-9A-Z]{16}\\b", // AWS access key
      "\\bASIA[0-9A-Z]{16}\\b", // AWS temporary access key
      "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b", // GitHub personal/OAuth/app/refresh token
      "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", // Slack token
      "\\bsk_(?:live|test)_[A-Za-z0-9]{16,}\\b", // Stripe secret key
      "\\bnpm_[A-Za-z0-9]{36}\\b", // npm access token
      "\\bAIza[0-9A-Za-z_-]{35}\\b", // Google API key
      "-----BEGIN(?: RSA| EC| OPENSSH| DSA)? PRIVATE KEY-----", // PEM private key
      "://[^/\\s:@]+:[^/\\s:@]+@", // credentials embedded in a URL
    ],
    binaryExtensions: [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".webp",
      ".pdf",
      ".zip",
      ".gz",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
      ".mp4",
      ".mp3",
      ".wasm",
    ],
  },
  coverage: {
    budgetsPath: "gates/coverage-budgets.json",
    summaryGlobs: [
      "apps/*/coverage/coverage-summary.json",
      "packages/*/coverage/coverage-summary.json",
    ],
  },
  ciParity: {
    configPath: "gates/ci-parity-config.json",
    rootGate: "check:all",
    entryGates: ["check:all", "verify"],
    workflowPrefix: "ci",
  },
  bundleSize: { budgetsPath: "gates/bundle-size-budgets.json", targets: [] },
  report: { junitGlobs: [], topN: 20 },
  agents: {
    targets: [],
    knownMissingPaths: [],
    runnerCommand: "pnpm",
    ignoredSubcommands: [
      "run",
      "install",
      "i",
      "add",
      "remove",
      "rm",
      "up",
      "update",
      "exec",
      "dlx",
      "why",
      "store",
      "prune",
      "audit",
      "outdated",
      "list",
      "ls",
      "link",
      "unlink",
      "publish",
      "pack",
      "rebuild",
      "approve-builds",
      "config",
      "dedupe",
      "fetch",
      "import",
      "patch",
      "setup",
      "create",
    ],
  },
  docsCoverage: { docsGlobs: [], surfaces: [], exclude: [] },
};

export const CONFIG_FILENAMES = ["repo-gates.config.json"] as const;

export type Ctx = { repoRoot: string; config: RepoGatesConfig };

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One-level-deep merge: overlay's top-level object sections are merged
 *  key-by-key over the base; scalars and arrays replace wholesale. */
export function mergeConfig(
  base: RepoGatesConfig,
  overlay: DeepPartial<RepoGatesConfig>,
): RepoGatesConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const baseValue = (base as Record<string, unknown>)[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(value) ? { ...baseValue, ...value } : value;
  }
  return out as RepoGatesConfig;
}

export function findConfigFile(repoRoot: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = resolve(repoRoot, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadConfig(repoRoot: string = process.cwd()): RepoGatesConfig {
  const file = findConfigFile(repoRoot);
  if (!file) return DEFAULT_CONFIG;
  const overlay = JSON.parse(readFileSync(file, "utf8")) as DeepPartial<RepoGatesConfig>;
  return mergeConfig(DEFAULT_CONFIG, overlay);
}

export function loadContext(repoRoot: string = process.cwd()): Ctx {
  return { repoRoot, config: loadConfig(repoRoot) };
}
