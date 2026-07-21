#!/usr/bin/env node
/**
 * The `repo-gates` CLI — a single dispatcher over the gate engine, so a consumer
 * repo wires `"check:all": "repo-gates check-all"` (etc.) instead of node-running
 * a path into node_modules. Each subcommand maps to the same exported engine
 * function the individual `bin/*.ts` entries call; flags are read positionally-
 * insensitively (`argv.includes`), matching those entries.
 */
import { runBundleSize } from "../bundle-size.ts";
import { runCheckAll } from "../check-all.ts";
import { runCiParity } from "../ci-parity.ts";
import { loadContext } from "../config.ts";
import { runCoverage } from "../coverage.ts";
import { runDebtMarkers } from "../debt-markers.ts";
import { runFileSizes } from "../file-sizes.ts";
import { runInit } from "../init.ts";
import { runQualityMetrics, runTestTiming } from "../report.ts";
import { runValidateAgents } from "../validate-agents.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (flag: string) => argv.includes(flag);

const USAGE = `repo-gates — config-driven repo quality gates

Usage: repo-gates <command> [options]

Commands:
  check-all [--bail]        Run the whole gate manifest (quiet; --bail stops at first fail)
  check-size [--init]       Per-file line-count ratchet (--init seeds baselines)
  check-debt [--init]       Debt-marker (TODO/FIXME) ratchet (--init seeds the allowlist)
  check-coverage [--init]   Per-package coverage floors (--init seeds; --skip-run reuses summaries)
  check-bundle-size [--init]Bundle raw+gzip+chunk ratchet (--init seeds)
  check-agents              Validate AGENTS.md script/path references resolve
  check-ci-parity           Fail if CI workflows drift from the check:all manifest
  report-test-timing        Non-gating test-timing dashboard (→ stdout / step summary)
  report-quality-metrics    Non-gating code-quality dashboard
  init                      Scaffold repo-gates.config.json + gates/ into the current repo

Config: repo-gates.config.json at the repo root (partial overlay on built-in defaults).
Docs:   https://github.com/kellykampen/repo-gates`;

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

// `init` runs BEFORE loadContext — there is no config yet in a fresh repo.
if (cmd === "init") {
  process.exitCode = runInit(process.cwd());
} else {
  const ctx = loadContext();
  switch (cmd) {
    case "check-all":
      process.exitCode = runCheckAll(ctx, {
        verbose: process.env.CHECK_ALL_VERBOSE === "1",
        bail: has("--bail"),
      });
      break;
    case "check-size":
      process.exitCode = runFileSizes(ctx, has("--init"));
      break;
    case "check-debt":
      process.exitCode = runDebtMarkers(ctx, has("--init"));
      break;
    case "check-coverage":
      process.exitCode = runCoverage(ctx, { init: has("--init"), skipRun: has("--skip-run") });
      break;
    case "check-bundle-size":
      process.exitCode = runBundleSize(ctx, has("--init"));
      break;
    case "check-agents":
      process.exitCode = runValidateAgents(ctx);
      break;
    case "check-ci-parity":
      process.exitCode = runCiParity(ctx);
      break;
    case "report-test-timing":
      process.exitCode = runTestTiming(ctx);
      break;
    case "report-quality-metrics":
      process.exitCode = runQualityMetrics(ctx);
      break;
    default:
      console.error(`repo-gates: unknown command '${cmd}'\n`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}
