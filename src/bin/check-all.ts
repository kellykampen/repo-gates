import { loadContext } from "../config.ts";
import { runCheckAll } from "../check-all.ts";

const verbose = process.env.CHECK_ALL_VERBOSE === "1";
const bail = process.argv.includes("--bail");
process.exitCode = runCheckAll(loadContext(), { verbose, bail });
