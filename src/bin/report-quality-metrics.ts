import { loadContext } from "../config.ts";
import { runQualityMetrics } from "../report.ts";

process.exitCode = runQualityMetrics(loadContext());
