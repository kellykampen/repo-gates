# repo-gates

Config-driven quality gates for **turborepo** (and any) monorepos — one quiet
`check-all` command that runs your whole battery (lint, format, typecheck, tests)
alongside ratchet guards for file size, tech-debt markers, coverage, and bundle
size, plus a CI-parity drift detector. The engine is repo-agnostic; your policy
lives in a single `repo-gates.config.json`.

## What it does

`check-all` runs an ordered manifest of gates and reports them **quietly** — one
aligned line per gate, a tally, and (on failure) the parsed failure signature
instead of a wall of logs:

```text
✓ lint              (2.5s)
✓ format:check      (5.9s)
✓ typecheck         (0.5s)
✓ check:size        (0.3s)
✓ check:debt        (0.3s)
✓ test              (8.1s)
✓ check:coverage    (9.4s)
✓ check:ci-parity   (0.3s)

8/8 gates passed (24.3s)

Scores:
  coverage   lowest packages/api 81.2% lines (12 pkgs ≥ floor)
  file-size  tightest src/app.ts 512/512 (0 to spare)
```

The gates:

| Command             | What it does                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-all`         | Runs the whole manifest quietly: aligned `✓/✗ gate (N.Ns)`, a tally, and parsed failure signatures (never the full log). On success prints a compact `Scores:` block. `--bail` stops at the first failure; `CHECK_ALL_VERBOSE=1` streams everything. |
| `check-ci-parity`   | Fails when a `pnpm run <gate>` in `.github/workflows/ci*.yml` isn't reachable from `check-all` — kills CI/local drift.                                                                                                                     |
| `check-size`        | Per-file line ceiling; large files are grandfathered and may only shrink. `--init` seeds baselines.                                                                                                                                       |
| `check-debt`        | `TODO/FIXME/HACK/XXX` must carry a tracker ref (`ABC-123` / `#123` / URL) or be allowlisted. `--init` seeds the allowlist.                                                                                                                 |
| `check-agents`      | Fails if a `pnpm run <x>` or a backticked path in `AGENTS.md` no longer resolves.                                                                                                                                                         |
| `check-coverage`    | Holds **each package** to its own floor (no repo-wide aggregate — a high package can't mask a low one); unlisted packages must meet a `default`. Floors ratchet up. `--init` seeds; `--skip-run` reuses existing summaries.                |
| `check-bundle-size` | Builds each configured target (turbo, cached), then ratchets raw+gzip totals AND the largest single chunk per bucket. `--init` re-baselines.                                                                                              |
| `report-test-timing` / `report-quality-metrics` | Non-gating dashboards → `$GITHUB_STEP_SUMMARY`.                                                                                                                                        |

## Why

- **One quiet command.** `check-all` is the single entry point — aligned pass/fail, a tally, and parsed failure signatures instead of a wall of logs. `--bail` stops early; `CHECK_ALL_VERBOSE=1` streams everything.
- **Ratchets, not fixed limits.** File size, tech debt, coverage, and bundle size only move in the right direction. `--init` seeds each baseline from your current tree, so day one is green — no big cleanup up front.
- **Per-package coverage floors.** Each package is held to its own floor, so a well-covered package can't mask a thin one.
- **CI ↔ local parity.** `check-ci-parity` fails if your CI workflow drifts from the `check-all` manifest, so "green locally" means "green in CI."
- **Config-driven & reusable.** The engine ships no repo-specific assumptions; drop it into any repo and describe policy in one JSON file.

## How to use it

### Install

```bash
pnpm add -D @kellykampen/repo-gates
# or: npm i -D @kellykampen/repo-gates  /  yarn add -D @kellykampen/repo-gates
```

Ships compiled JS + types — no build step or Node type-stripping required in your
repo (Node ≥ 18).

### Quickstart

```bash
pnpm exec repo-gates init          # writes repo-gates.config.json + gates/
pnpm exec repo-gates check-size --init      # seed the ratchet baselines from your
pnpm exec repo-gates check-debt --init      #   current tree, so day one is green
pnpm exec repo-gates check-coverage --init
pnpm exec repo-gates check-all     # run the whole battery
```

### Wire it up

```jsonc
{
  "scripts": {
    "check:all": "repo-gates check-all",
    "check:size": "repo-gates check-size",
    "check:debt": "repo-gates check-debt",
    "check:coverage": "repo-gates check-coverage",
    "check:ci-parity": "repo-gates check-ci-parity"
  }
}
```

## How it finds your repo

Every command resolves the repo root from `process.cwd()` and loads
`repo-gates.config.json` from there (falling back to the built-in `DEFAULT_CONFIG`).
The config is a **partial overlay** on the defaults — set only what differs.

## Configuration

`repo-gates.config.json` is a **partial overlay** on the built-in defaults — set only
what differs from your repo. JSON is parsed strictly (no `//` comments); use a
`"$comment"` key for inline notes, as below.

### Example

A realistic config for a pnpm + turbo monorepo (an Electron app, a web app, shared
packages):

```jsonc
{
  "$comment": "Anything omitted falls back to DEFAULT_CONFIG.",
  "runner": "pnpm run",

  // Each package/app's vitest coverage-summary.json — check-coverage holds each to
  // its own floor (gates/coverage-budgets.json), seeded by `check-coverage --init`.
  "coverage": {
    "summaryGlobs": [
      "apps/*/coverage/coverage-summary.json",
      "packages/*/coverage/coverage-summary.json"
    ]
  },

  // Build + measure bundle budgets. Each target is built via
  // `turbo run build --filter <filter>`, then dist is measured by bucket.
  "bundleSize": {
    "targets": [
      { "name": "web", "filter": "@acme/web", "distDir": "apps/web/dist",
        "buckets": { "js": [".js"], "css": [".css"] } }
    ]
  },

  // check-agents: keep AGENTS.md's `pnpm run <script>` + backticked paths resolving.
  "agents": { "targets": ["AGENTS.md"] },

  // report-test-timing reads these junit files (non-gating dashboard).
  "report": { "junitGlobs": ["apps/*/test-results/junit.xml", "packages/*/test-results/junit.xml"] },

  // Architectural import rules → ESLint (see "Import boundaries" below).
  "boundaries": [
    {
      // ONE cross-app rule for every app (message written once). Safe as long as
      // apps don't import their own package by name.
      "name": "no-cross-app",
      "files": ["apps/**"],
      "patterns": [
        { "forbid": ["@acme/web", "@acme/web/**", "@acme/desktop", "@acme/desktop/**"],
          "message": "Apps must not import each other — share via packages/*." }
      ]
    },
    {
      // Nested scope: inherits no-cross-app's patterns via `extends` (no copy-paste),
      // and adds its own.
      "name": "desktop-renderer",
      "files": ["apps/desktop/src/renderer/**"],
      "ignores": ["**/*.test.ts", "**/*.test.tsx"],
      "extends": ["no-cross-app"],
      "patterns": [
        { "forbid": ["node:*", "better-sqlite3", "**/main/**"],
          "allowTypeImports": true,
          "message": "Renderer is a browser context — reach main via IPC, not a value import (import type is fine)." }
      ]
    }
  ]
}
```

### Reference

| Key | Default | Purpose |
| --- | --- | --- |
| `runner` | `"pnpm run"` | How a gate script is invoked (`"pnpm run"`, `"bun run"`, `"npm run"`). |
| `gates` | 13-gate manifest | Ordered `{ name, conditional }[]`. **Core** gates (`conditional: false`: lint, format:check, typecheck, check:size, check:debt, test, check:ci-parity) must exist or the run fails; **conditional** gates (check:scripts, check:deps, check:dups, check:agents, check:bundle-size, check:coverage) run only if you define that script. Override to add/remove/reorder. |
| `scanRoots` | `["apps","packages","scripts"]` | Roots the file-size + debt walkers scan. |
| `excludeDirSegments` | `node_modules`, `dist`, `out`, `.turbo`, `coverage`, … | Directory names pruned from scans. |
| `excludePathPrefixes` | `[]` | Repo-relative path prefixes excluded from scans. |
| `sourceExtensions` | `[".ts",".tsx"]` | Extensions the size/debt guards treat as source. |
| `fileSize.threshold` | `600` | Default per-file line ceiling (larger files are grandfathered in the budgets file). |
| `fileSize.budgetsPath` | `gates/file-size-budgets.json` | Grandfathered per-file budgets (`check-size --init` seeds). |
| `debt.markerTokens` | `["TODO","FIXME","HACK","XXX"]` | Tokens that must carry a tracker reference. |
| `debt.trackerPatterns` | `ABC-123`, `#123`, URL | Regex sources for a valid tracker reference. |
| `debt.allowlistPath` | `gates/debt-marker-allowlist.json` | Untracked-marker allowlist (`check-debt --init` seeds). |
| `coverage.summaryGlobs` | `apps/*`, `packages/*` | Globs matching each package's `coverage-summary.json`. |
| `coverage.budgetsPath` | `gates/coverage-budgets.json` | Per-package floors (`check-coverage --init` seeds; floors ratchet up). |
| `bundleSize.targets` | `[]` (no-op) | `[{ name, filter, distDir, buckets }]` — built via turbo, then raw+gzip+largest-chunk ratcheted. |
| `bundleSize.budgetsPath` | `gates/bundle-size-budgets.json` | Bundle baselines. |
| `agents.targets` | `[]` | Agent docs (e.g. `["AGENTS.md"]`) whose `pnpm run <x>` + backticked paths must resolve. |
| `report.junitGlobs` | `[]` | junit files for the `report-test-timing` dashboard. |
| `report.topN` | `20` | Slowest-tests cutoff in that dashboard. |
| `ciParity.{configPath,rootGate,entryGates,workflowPrefix}` | `gates/ci-parity-config.json`, `check:all`, `["check:all","verify"]`, `ci` | Inputs to the CI-parity reachability graph. |
| `boundaries` | `[]` | Import-boundary rules → ESLint (below). |

The full `RepoGatesConfig` type is exported from the package for editor autocompletion.

### Import boundaries (ESLint)

Architectural import rules are _data_ in `repo-gates.config.json` under `boundaries`;
the transform `@kellykampen/repo-gates/eslint-boundaries` turns them into
`@typescript-eslint/no-restricted-imports` flat configs you spread into your
`eslint.config.mjs`:

```js
import { boundariesToEslintConfigs } from "@kellykampen/repo-gates/eslint-boundaries";
import repoGates from "./repo-gates.config.json" with { type: "json" };

export default [
  // …your other flat configs…
  ...boundariesToEslintConfigs(repoGates.boundaries ?? []),
];
```

Each boundary is one file scope carrying pattern groups; per-group `allowTypeImports`
lets a browser context still `import type` a Node-only module. `ignores` exempts files
(commonly tests, which run in Node).

Because ESLint flat config is **last-wins per rule**, a file matched by several
boundaries only keeps the *last* one's patterns — so a nested scope (`renderer/**` ⊂
`apps/**`) must carry the broader patterns too. Instead of copy-pasting them, use
**`extends`**: `{ "name": "desktop-renderer", "extends": ["no-cross-app"], … }` merges
the named boundaries' patterns in ahead of its own (resolved transitively, cycles
rejected). Author each rule — and its message — **once**, at its natural scope.

**Scores protocol:** any gate contributes a headline to `check-all`'s success
`Scores:` block by printing `SCORE: <label> — <value>` on success; `check-all`
collects and aligns them.

## CI

Run the battery as one job step (Node ≥ 18, deps installed):

```yaml
- run: pnpm exec repo-gates check-all
```

Keep the CI workflow and the `check-all` manifest in lock-step with
`repo-gates check-ci-parity`.

Full copy-paste-able GitHub Actions workflows, from a single `check-all` step
up to a per-gate turborepo battery with remote caching, live in
[`examples/github-actions/`](./examples/github-actions):

- [`minimal.yml`](./examples/github-actions/minimal.yml) — one `check-all` step.
- [`single-package.yml`](./examples/github-actions/single-package.yml) — gates
  broken into individual steps for a single-package (or lightly-workspaced) repo.
- [`monorepo-turborepo.yml`](./examples/github-actions/monorepo-turborepo.yml) —
  the full battery (deps/dups/size/debt/agents/bundle-size/coverage ratchets +
  Turbo remote cache) for a pnpm + turbo monorepo.

## Programmatic use

```ts
import { loadContext, runCheckAll } from "@kellykampen/repo-gates";

process.exitCode = runCheckAll(loadContext(), { verbose: false });
```

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm run typecheck # tsc --noEmit
pnpm run build     # tsup → dist/ (esm + d.ts)
```

## License

[MIT](./LICENSE) © Kelly Kampen
