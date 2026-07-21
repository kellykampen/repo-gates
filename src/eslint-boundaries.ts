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
 * / message). When scopes nest (e.g. `apps/x/renderer/**` ⊂ `apps/x/**`), the
 * narrower boundary must carry the broader patterns too. Rather than copy-paste
 * them, give it `extends: ["<broader-boundary>"]` — this module merges the named
 * boundaries' patterns in ahead of its own, so each rule is authored ONCE.
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
  /** Names of other boundaries whose `patterns` are merged in ahead of this
   *  boundary's own. Lets a nested scope inherit a broader scope's rules
   *  without copy-pasting them (only `patterns` are inherited, never `files`). */
  extends?: string[];
};

export type BoundaryEslintConfig = {
  name: string;
  files: string[];
  ignores?: string[];
  rules: Record<string, unknown>;
};

/** Effective patterns for a boundary: those of every `extends` ancestor (depth-first,
 *  cycle-guarded) followed by the boundary's own. */
function resolvePatterns(
  b: Boundary,
  byName: Map<string, Boundary>,
  seen: Set<string>,
): BoundaryPattern[] {
  if (seen.has(b.name)) {
    throw new Error(
      `repo-gates boundaries: circular \`extends\` involving "${b.name}" (${[...seen, b.name].join(" → ")}).`,
    );
  }
  const inherited: BoundaryPattern[] = [];
  for (const parentName of b.extends ?? []) {
    const parent = byName.get(parentName);
    if (!parent) {
      throw new Error(`repo-gates boundary "${b.name}" extends unknown boundary "${parentName}".`);
    }
    inherited.push(...resolvePatterns(parent, byName, new Set([...seen, b.name])));
  }
  return [...inherited, ...b.patterns];
}

export function boundariesToEslintConfigs(boundaries: Boundary[]): BoundaryEslintConfig[] {
  const byName = new Map(boundaries.map((b) => [b.name, b]));
  return boundaries.map((b) => ({
    name: `repo-gates/boundary/${b.name}`,
    files: b.files,
    ...(b.ignores ? { ignores: b.ignores } : {}),
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: resolvePatterns(b, byName, new Set()).map((p) => ({
            group: p.forbid,
            allowTypeImports: p.allowTypeImports ?? false,
            message: p.message ?? `Import boundary "${b.name}" violated.`,
          })),
        },
      ],
    },
  }));
}
