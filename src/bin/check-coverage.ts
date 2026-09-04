import { loadContext } from "../config.ts";
import { runCoverage } from "../coverage.ts";

const init = process.argv.includes("--init");
const skipRun = process.argv.includes("--skip-run");
// --partial: only some packages were run (CI scoping coverage to the affected ones). Budget
// entries with no summary are then treated as "not run, floor held" rather than stale — but
// only when the package directory still exists, so a deleted package is still caught.
const partial = process.argv.includes("--partial");
process.exitCode = runCoverage(loadContext(), { init, skipRun, partial });
