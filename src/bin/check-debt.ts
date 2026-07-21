import { loadContext } from "../config.ts";
import { runDebtMarkers } from "../debt-markers.ts";

process.exitCode = runDebtMarkers(loadContext(), process.argv.includes("--init"));
