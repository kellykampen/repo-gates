/**
 * Import-boundary → ESLint flat-config generator (repo-agnostic).
 *
 * The *rules* (which import specifiers are forbidden in which files) are
 * DATA the consumer supplies from its own `repo-gates.config.json`; this
 * module only shapes that data into `@typescript-eslint/no-restricted-imports`
 * flat-config entries. repo-gates never learns any repo's specific packages.
 *
 * IMPORTANT — ESLint flat config does NOT merge rule options across matching
 * configs; the LAST matching config wins outright. So a file must get ALL its
 * forbidden patterns from a SINGLE config. Hence each boundary is ONE file
 * scope carrying a LIST of pattern groups (each with its own `allowTypeImports`
 * / message). When scopes nest (e.g. `apps/x/renderer/**` ⊂ `apps/x/**`),
 * author the narrower boundary to RE-INCLUDE the broader patterns and order it
 * later so it wins without losing the broader rule.
 */

export type BoundaryPattern = {
  /** Forbidden import-specifier glob patterns (minimatch on the specifier). */
  forbid: string[];
  /** Allow `import type { … }` through (blocks only value imports). */
  allowTypeImports?: boolean;
  /** Custom violation message for this group. */
  message?: string;
};

export type Boundary = {
  /** Stable id, surfaced in the ESLint config name. */
  name: string;
  /** File globs the rule applies to (ESLint `files`). */
  files: string[];
  /** File globs excluded from this boundary (ESLint `ignores`) — e.g. test
   *  files, which run in Node and may touch anything for setup. */
  ignores?: string[];
  /** One or more forbidden-pattern groups applied to those files. */
  patterns: BoundaryPattern[];
};

export type BoundaryEslintConfig = {
  name: string;
  files: string[];
  ignores?: string[];
  rules: Record<string, unknown>;
};

export function boundariesToEslintConfigs(boundaries: Boundary[]): BoundaryEslintConfig[] {
  return boundaries.map((b) => ({
    name: `repo-gates/boundary/${b.name}`,
    files: b.files,
    ...(b.ignores ? { ignores: b.ignores } : {}),
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: b.patterns.map((p) => ({
            group: p.forbid,
            allowTypeImports: p.allowTypeImports ?? false,
            message: p.message ?? `Import boundary "${b.name}" violated.`,
          })),
        },
      ],
    },
  }));
}
