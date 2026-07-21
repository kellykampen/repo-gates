import { loadContext } from "../config.ts";
import { runValidateAgents } from "../validate-agents.ts";

process.exitCode = runValidateAgents(loadContext());
