/**
 * @kellykampen/repo-gates — config-driven repo quality gates.
 *
 * The engine is repo-agnostic; per-repo policy lives in the consumer's
 * `repo-gates.config.json` (see ./config.ts). Bins under ./bin invoke
 * these engines with a context resolved from `process.cwd()`.
 */

export * from "./config.ts";
export * from "./check-all.ts";
export * from "./ci-parity.ts";
export * as fileSizes from "./file-sizes.ts";
export * as debtMarkers from "./debt-markers.ts";
export * as coverage from "./coverage.ts";
export * as bundleSize from "./bundle-size.ts";
export * from "./eslint-boundaries.ts";
export * as validateAgents from "./validate-agents.ts";
export * as report from "./report.ts";
