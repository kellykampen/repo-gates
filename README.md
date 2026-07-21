# @kellykampen/repo-gates

Config-driven repo quality gates for **turborepo** (and any) monorepos: a quiet
`check-all` orchestrator, a CI-parity drift detector, and ratchet guards for file
size, debt markers, coverage, and bundle size. The **engine is repo-agnostic**;
per-repo **policy** lives in your `repo-gates.config.json`.

Inspired by the byte-identical `check:all` standard in
[jayminwest/warren](https://github.com/jayminwest/warren), adapted to Node + pnpm +
turbo + vitest.

## Install

```bash
pnpm add -D @kellykampen/repo-gates
# or: npm i -D @kellykampen/repo-gates  /  yarn add -D @kellykampen/repo-gates
```

Ships compiled JS + types — no build step or Node type-stripping required in your
repo (Node ≥ 18).

## Quickstart

```bash
pnpm exec repo-gates init          # writes repo-gates.config.json + gates/
pnpm exec repo-gates check-size --init      # seed the ratchet baselines from your
pnpm exec repo-gates check-debt --init      #   current tree, so day one is green
pnpm exec repo-gates check-coverage --init
pnpm exec repo-gates check-all     # run the whole battery
```

Then wire the commands as scripts:

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

## What it provides

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

## How it finds your repo

Every command resolves the repo root from `process.cwd()` and loads
`repo-gates.config.json` from there (falling back to the built-in `DEFAULT_CONFIG`).
The config is a **partial overlay** on the defaults — set only what differs.

## Config surface (highlights)

- `runner` — how a gate is invoked (`"pnpm run"`, `"bun run"`, …).
- `gates` — the ordered manifest; core gates are mandatory, conditional gates run only when the repo defines them.
- `scanRoots` / `excludeDirSegments` / `sourceExtensions` — for the size + debt walkers.
- `fileSize.threshold`, `*.budgetsPath`, `debt.trackerPatterns`, `coverage.summaryGlobs` — per-gate policy.
- `bundleSize.targets` — `[{ name, filter, distDir, buckets }]`; each is built via `turbo run build --filter <filter>` then measured. Empty ⇒ the gate is a no-op.
- `ciParity.{rootGate,entryGates,workflowPrefix,configPath}` — parity graph inputs.

Full shape: the `RepoGatesConfig` type, exported from the package.

**Import boundaries (ESLint):** architectural import rules are _data_ in
`repo-gates.config.json` under `boundaries`; the transform
`@kellykampen/repo-gates/eslint-boundaries` turns them into
`@typescript-eslint/no-restricted-imports` flat configs you spread into
`eslint.config.mjs`. Each boundary is one file scope carrying pattern groups
(per-group `allowTypeImports`). Because flat config is last-wins per rule, nest
broader scopes earlier and narrower ones later.

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
