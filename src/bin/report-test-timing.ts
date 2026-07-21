import { loadContext } from "../config.ts";
import { runTestTiming } from "../report.ts";

process.exitCode = runTestTiming(loadContext());
