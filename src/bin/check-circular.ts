import { runCircularImports } from "../circular-imports.ts";
import { loadContext } from "../config.ts";

process.exitCode = runCircularImports(loadContext(), process.argv.includes("--init"));
