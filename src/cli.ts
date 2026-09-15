#!/usr/bin/env node
import { CommanderError } from "commander";
import { createProgram } from "./program";
import { safe } from "./output";
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
createProgram({ signal: controller.signal }).exitOverride().parseAsync(process.argv).catch(error => {
  if (controller.signal.aborted) { console.error("Stopped. Accepted deliveries continue on the server."); process.exitCode = 130; }
  else if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else { console.error(`Error: ${safe(error instanceof Error ? error.message : error)}`); process.exitCode = 1; }
}).finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
