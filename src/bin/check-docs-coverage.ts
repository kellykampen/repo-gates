import { loadContext } from "../config.ts";
import { runDocsCoverage } from "../docs-coverage.ts";

process.exitCode = await runDocsCoverage(loadContext());
