import chalk from "chalk";
import Table from "cli-table3";
import { stripVTControlCharacters } from "node:util";
import type { Endpoint, EventStatus, Attempt } from "./api";
// Webhook URLs, event types and error messages are untrusted terminal input.
export function safe(value: unknown) { return stripVTControlCharacters(String(value ?? "—")).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
export function colored(value: string) {
  const text = safe(value);
  if (["CLOSED", "SUCCESS", "DELIVERED"].includes(value)) return chalk.green(text);
  if (["OPEN", "FAILED", "TIMEOUT", "DEAD_LETTERED"].includes(value)) return chalk.red(text);
  return chalk.yellow(text);
}
export function endpointTable(endpoints: Endpoint[]) {
  if (!endpoints.length) return "No endpoints yet. Run `hooka endpoints add <url>`.";
  const table = new Table({ head: ["ID", "URL", "Circuit", "Success (24h)"], wordWrap: true });
  endpoints.forEach(ep => table.push([safe(ep.id), safe(ep.url), colored(ep.circuitState), ep.successRate === null ? "—" : `${ep.successRate}%`]));
  return table.toString();
}
export function statusTable(value: EventStatus) {
  if (!value.deliveries.length) return "No matching endpoints; no deliveries were queued.";
  const table = new Table({ head: ["Endpoint", "Status", "Attempts", "Final result"] });
  value.deliveries.forEach(d => table.push([safe(d.endpoint.url), colored(d.status), d.attempts, safe(d.lastAttempt?.httpStatusCode ?? d.lastAttempt?.error ?? d.lastAttempt?.status ?? "Waiting")]));
  return table.toString();
}
export function attemptLine(a: Attempt) { return [safe(a.createdAt), safe(a.event.type), safe(a.endpoint.url), colored(a.status), `HTTP ${a.httpStatusCode ?? "—"}`, `${a.durationMs ?? "—"}ms`, safe(a.id)].join("  "); }
