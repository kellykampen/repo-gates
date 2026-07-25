import { loadContext } from "../config.ts";
import { runSecrets } from "../secrets.ts";

process.exitCode = runSecrets(loadContext(), process.argv.includes("--init"));
