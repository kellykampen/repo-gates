import { loadContext } from "../config.ts";
import { runCoverage } from "../coverage.ts";

const init = process.argv.includes("--init");
const skipRun = process.argv.includes("--skip-run");
process.exitCode = runCoverage(loadContext(), { init, skipRun });
