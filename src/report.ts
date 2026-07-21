/**
 * Non-gating CI dashboards (report:test-timing, report:quality-metrics),
 * adapted from warren-cec7 / warren-5b95.
 *
 * These enforce nothing — each ratchet gate already fails the build on its
 * own. They render the current state into `$GITHUB_STEP_SUMMARY` (and stdout)
 * so reviewers see it at a glance. Missing inputs degrade to a "—" row rather
 * than failing.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Ctx } from "./config.ts";
import { collectPerPackage, lowest } from "./coverage.ts";
import { tightest } from "./file-sizes.ts";
import { scan as scanDebt } from "./debt-markers.ts";
import { expandGlob } from "./coverage.ts";

// ── test timing ────────────────────────────────────────────────────────────

export type TestCase = { name: string; classname: string; file: string; timeSeconds: number };
export type TimingReport = { totalSeconds: number; totalTests: number; cases: TestCase[] };

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const match of xml.matchAll(/<testcase\b[^>]*\/?>/g)) {
    const tag = match[0];
    const timeSeconds = Number.parseFloat(attr(tag, "time") ?? "0");
    if (!Number.isFinite(timeSeconds)) continue;
    cases.push({
      name: attr(tag, "name") ?? "",
      classname: attr(tag, "classname") ?? "",
      file: attr(tag, "file") ?? attr(tag, "classname") ?? "",
      timeSeconds,
    });
  }
  return cases;
}

function fmtSeconds(s: number): string {
  return s >= 1 ? `${s.toFixed(2)}s` : `${(s * 1000).toFixed(1)}ms`;
}

export function collectTiming(ctx: Ctx): { report: TimingReport; files: number } {
  const cases: TestCase[] = [];
  let files = 0;
  for (const glob of ctx.config.report.junitGlobs) {
    for (const path of expandGlob(ctx.repoRoot, glob)) {
      files++;
      cases.push(...parseJUnit(readFileSync(path, "utf8")));
    }
  }
  const totalSeconds = cases.reduce((a, c) => a + c.timeSeconds, 0);
  return { report: { totalSeconds, totalTests: cases.length, cases }, files };
}

export function formatTiming(report: TimingReport, topN: number): string {
  const slowest = [...report.cases].sort((a, b) => b.timeSeconds - a.timeSeconds).slice(0, topN);
  const lines = [
    "## Test timing",
    "",
    `**Total:** ${fmtSeconds(report.totalSeconds)} across ${report.totalTests} tests.`,
    "",
    `### Slowest ${slowest.length} tests`,
    "",
    "| Time | Test | File |",
    "| ---: | --- | --- |",
  ];
  for (const c of slowest) {
    const name = `${c.classname} › ${c.name}`.replaceAll("|", "\\|");
    lines.push(`| ${fmtSeconds(c.timeSeconds)} | ${name} | \`${c.file}\` |`);
  }
  return `${lines.join("\n")}\n`;
}

// ── quality metrics ──────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** A consolidated table of the ratchet gates' current headline metrics. */
export function formatQualityMetrics(ctx: Ctx): string {
  const rows: [string, string][] = [];

  // Coverage — lowest package (reads already-produced summaries).
  try {
    const per = collectPerPackage(ctx);
    const min = lowest(per);
    rows.push([
      "Coverage (lowest pkg)",
      min ? `${pct(min.lines)} lines — \`${min.pkg}\` (${per.length} pkgs)` : "—",
    ]);
  } catch {
    rows.push(["Coverage (lowest pkg)", "—"]);
  }

  // File size — tightest headroom.
  try {
    const t = tightest(ctx);
    rows.push([
      "File size (tightest)",
      t ? `\`${t.path}\` ${t.lines}/${t.budget} (${t.headroom} to spare)` : "—",
    ]);
  } catch {
    rows.push(["File size (tightest)", "—"]);
  }

  // Debt markers — grandfathered / untracked counts.
  try {
    const { untracked } = scanDebt(ctx);
    rows.push(["Debt markers (untracked)", String(untracked.length)]);
  } catch {
    rows.push(["Debt markers (untracked)", "—"]);
  }

  // Bundle size — gzip totals per target from the budgets file.
  try {
    const path = resolve(ctx.repoRoot, ctx.config.bundleSize.budgetsPath);
    if (existsSync(path)) {
      const budgets = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const t of ctx.config.bundleSize.targets) {
        const b = budgets[t.name] as { totals?: { gzip?: Record<string, number> } } | undefined;
        const gzip = b?.totals?.gzip ?? {};
        const total = Object.values(gzip).reduce((a, v) => a + v, 0);
        rows.push([`Bundle budget (${t.name})`, `${(total / 1024).toFixed(1)} KB gz`]);
      }
    }
  } catch {
    rows.push(["Bundle budget", "—"]);
  }

  const lines = ["## Code-quality metrics", "", "| Metric | Current |", "| --- | --- |"];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return `${lines.join("\n")}\n`;
}

// ── output ───────────────────────────────────────────────────────────────────

export function emitSummary(markdown: string): void {
  process.stdout.write(`${markdown}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `${markdown}\n`);
    } catch (err) {
      console.error(`report: could not write GITHUB_STEP_SUMMARY: ${err}`);
    }
  }
}

export function runTestTiming(ctx: Ctx): number {
  const { report, files } = collectTiming(ctx);
  if (files === 0) {
    console.log("report:test-timing — no junit files found (run test:ci first); skipping.");
    return 0;
  }
  emitSummary(formatTiming(report, ctx.config.report.topN));
  return 0;
}

export function runQualityMetrics(ctx: Ctx): number {
  emitSummary(formatQualityMetrics(ctx));
  return 0;
}
