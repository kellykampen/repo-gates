import { loadContext } from "../config.ts";
import { runCiParity } from "../ci-parity.ts";

process.exitCode = runCiParity(loadContext());
