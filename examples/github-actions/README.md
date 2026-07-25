# GitHub Actions examples

Three complete workflows, in increasing order of granularity. Copy the one
that matches your repo's shape into `.github/workflows/ci.yml` and adjust the
`pnpm run <script>` names to whatever you wired up in `package.json` (see the
main README's [Wire it up](../../README.md#wire-it-up) section).

| File | Shape | Gate steps |
| --- | --- | --- |
| [`minimal.yml`](./minimal.yml) | Any repo, smallest setup | One `repo-gates check-all` step |
| [`single-package.yml`](./single-package.yml) | Single package or lightly-workspaced repo | lint, format, typecheck, size, debt, test, ci-parity, build |
| [`monorepo-turborepo.yml`](./monorepo-turborepo.yml) | pnpm + turbo monorepo | + deps (knip), dups (jscpd), agents, bundle-size, coverage ratchets, Turbo remote cache, non-gating report steps |

All three assume `pnpm`; swap the `pnpm/action-setup` + `pnpm install` steps
for `npm ci` / `yarn install --frozen-lockfile` if you use a different package
manager, and update the `pnpm run` steps to `npm run` / `yarn` accordingly.

## Why break `check-all` into individual steps at all?

`repo-gates check-all` alone (the `minimal.yml` shape) already runs the whole
battery and fails the build on the first failing gate — it's enough for most
repos. Individual steps (`single-package.yml`, `monorepo-turborepo.yml`) buy
you:

- **Legible logs** — a failing PR check reads "Debt-marker ratchet" instead of
  a buried line in one long `check-all` transcript.
- **`check-ci-parity`** — this only has something to verify once each
  `pnpm run <script>` in the workflow is its own step. It fails the build if a
  CI step isn't reachable from `check:all` (drift between "what CI runs" and
  "what `pnpm run check:all` runs locally"), unless justified as a genuine
  CI-only step in `gates/ci-parity-config.json`'s `ciOnly` list — `build` is
  the usual example, since a full build isn't part of the fast local gate
  battery.

## Turbo remote cache (monorepo-turborepo.yml only)

The `TURBO_TOKEN` / `TURBO_TEAM` env vars are optional. With them set (e.g. a
free Vercel remote cache), a PR replays cached results for every package it
didn't touch instead of re-running lint/typecheck/test/coverage/build from
scratch. Without them, turbo just runs everything locally — CI still passes,
only slower. Delete the `env:` block entirely if you don't use a remote cache.
