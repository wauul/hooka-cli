import type { Api, EventStatus, Attempt } from "./api";
export function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export async function waitForEvent(api: Pick<Api, "status">, id: string, options: { signal: AbortSignal; interval: number; timeout: number; generation?: number; update: (status: EventStatus) => void }) {
  const start = Date.now();
  let generation = options.generation;
  while (!options.signal.aborted) {
    const status = await api.status(id, generation);
    generation ??= status.generation; // Pin this run even if somebody replays concurrently.
    options.update(status);
    if (status.deliveries.every(d => ["DELIVERED", "DEAD_LETTERED"].includes(d.status))) return status;
    if (options.timeout && Date.now() - start >= options.timeout) throw new Error(`Still pending after ${options.timeout / 1000}s. Event ${id} continues on the server; use hooka tail to follow attempts.`);
    await pause(options.interval, options.signal);
  }
  throw new Error("Cancelled");
}
// Polling, not a server push stream. An SSE endpoint is a natural v2 upgrade.
// The API uses a timestamp + ID cursor and drains pages before sleeping. A
// bounded ID cache deduplicates overlap; this is a developer view, not an audit log.
export async function tailAttempts(api: Pick<Api, "attempts">, options: { signal: AbortSignal; interval: number; endpoint?: string; once?: boolean; print: (attempt: Attempt) => void }) {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await api.attempts(options.endpoint, cursor);
    for (const attempt of page.attempts) {
      if (!seen.has(attempt.id)) { options.print(attempt); seen.add(attempt.id); }
      if (seen.size > 10000) seen.delete(seen.values().next().value!);
    }
    cursor = page.nextCursor;
    if (page.hasMore && !options.signal.aborted) continue;
    if (options.once || options.signal.aborted) return;
    await pause(options.interval, options.signal);
  } while (!options.signal.aborted);
}
