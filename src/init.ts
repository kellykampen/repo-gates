/**
 * `repo-gates init` — scaffold a starter config into a fresh repo. Writes a minimal
 * `repo-gates.config.json` (a partial overlay on the built-in defaults — see config.ts)
 * plus an empty `gates/` dir, then prints the remaining wiring the tool can't do for
 * you (package.json scripts, seeding the ratchets, the CI step). Never overwrites an
 * existing config.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A minimal, valid starter — everything else falls back to the built-in defaults. */
const STARTER_CONFIG = {
  runner: "pnpm run",
  coverage: {
    summaryGlobs: ["packages/*/coverage/coverage-summary.json"],
  },
};

const NEXT_STEPS = `
Next steps:
  1. Add scripts to package.json (adjust to your runner):
       "check:all":        "repo-gates check-all",
       "check:size":       "repo-gates check-size",
       "check:debt":       "repo-gates check-debt",
       "check:coverage":   "repo-gates check-coverage",
       "check:ci-parity":  "repo-gates check-ci-parity"
     shadcn/ui repos only: add a pinned check:shadscan script using your package
     manager, application path, and assessed baseline floor (see README).
  2. Seed the ratchet baselines (writes into gates/):
       repo-gates check-size --init
       repo-gates check-debt --init
       repo-gates check-coverage --init
  3. Run the whole battery:
       repo-gates check-all
  4. (CI) run \`repo-gates check-all\` as a job step.

Tune policy in repo-gates.config.json — see the README for the full config surface.`;

export function runInit(cwd: string): number {
  const configPath = join(cwd, "repo-gates.config.json");
  if (existsSync(configPath)) {
    console.error(
      "repo-gates init: repo-gates.config.json already exists — not overwriting. Edit it directly.",
    );
    return 1;
  }
  writeFileSync(configPath, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`);
  mkdirSync(join(cwd, "gates"), { recursive: true });
  console.log(`✓ wrote repo-gates.config.json\n✓ created gates/${NEXT_STEPS}`);
  return 0;
}
