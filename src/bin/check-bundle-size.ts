import { loadContext } from "../config.ts";
import { runBundleSize } from "../bundle-size.ts";

process.exitCode = runBundleSize(loadContext(), process.argv.includes("--init"));
