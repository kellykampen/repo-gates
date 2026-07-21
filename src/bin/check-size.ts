import { loadContext } from "../config.ts";
import { runFileSizes } from "../file-sizes.ts";

process.exitCode = runFileSizes(loadContext(), process.argv.includes("--init"));
