import WebSocket from "ws";
import { safe } from "./output";
import { pause } from "./poll";
import type { Api } from "./api";

type LiveEvent = { type: "event"; attemptId: string; receiptId: string; replayId: string | null; eventType: string; receivedAt: string; headers: Record<string, string>; bodyBase64: string };
type ListenOptions = { signal: AbortSignal; log: (line: string) => void; tunnelUrl?: string; socketFactory?: (url: string) => WebSocket; forward?: typeof forwardLocal };
const transportHeaders = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "expect"]);

export function localForwardUrl(value: string) {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("--forward-to must be a localhost HTTP(S) URL without credentials or a fragment.");
  return url.toString();
}
export function liveUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Live relay must use WSS (WS is allowed for localhost only).");
  if (url.username || url.password || url.search || url.hash) throw new Error("Live relay URL cannot contain credentials, query or fragment.");
  return url.toString();
}
export async function forwardLocal(event: LiveEvent, url: string) {
  const start = Date.now();
  try {
    const body = Buffer.from(event.bodyBase64, "base64");
    const headers = Object.fromEntries(Object.entries(event.headers).filter(([name]) => !transportHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith("x-forwarded-")));
    const response = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10000) });
    const responseBody = Number(response.headers.get("content-length") || 0) <= 1024 ? (await response.text()).slice(0, 1024) : "";
    return { status: response.status, durationMs: Date.now() - start, responseBody };
  } catch (error) {
    return { status: null, durationMs: Date.now() - start, error: error instanceof Error ? error.message : "Local request failed" };
  }
}
export async function listen(client: Pick<Api, "live"> & { config: { apiKey: string } }, source: string, forwardTo: string, options: ListenOptions) {
  const destination = localForwardUrl(forwardTo);
  const url = liveUrl(options.tunnelUrl || (await client.live()).url);
  let backoff = 1000;
  while (!options.signal.aborted) {
    const socket = options.socketFactory ? options.socketFactory(url) : new WebSocket(url, { perMessageDeflate: false, maxPayload: 400000 });
    let subscribed = false;
    let closeCode = 0, closeReason = "";
    const timeout = setTimeout(() => socket.terminate(), 10000);
    const stop = () => socket.close(1000, "Client stopped");
    options.signal.addEventListener("abort", stop, { once: true });
    await new Promise<void>(resolve => {
      socket.once("open", () => socket.send(JSON.stringify({ type: "subscribe", apiKey: client.config.apiKey, source })));
      socket.on("message", data => { void (async () => {
        let message: LiveEvent | { type: "subscribed"; sourceId: string; sourceName: string };
        try { message = JSON.parse(data.toString("utf8")); } catch { return; }
        if (message.type === "subscribed") { subscribed = true; backoff = 1000; clearTimeout(timeout); options.log(`Live: listening to ${safe(message.sourceName)} (${safe(message.sourceId)}) → ${safe(destination)}`); return; }
        if (message.type !== "event" || !message.attemptId || !message.bodyBase64) return;
        const result = await (options.forward || forwardLocal)(message, destination);
        const stamp = new Date().toISOString();
        options.log(`${stamp}  ${safe(message.eventType)}${message.replayId ? "  REPLAY" : ""}  ${result.status ? `HTTP ${result.status}` : `ERROR ${safe(result.error)}`}  ${result.durationMs}ms`);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ack", attemptId: message.attemptId, ...result }));
      })().catch(error => options.log(`Local forwarding failed: ${safe(error instanceof Error ? error.message : error)}`)); });
      socket.once("error", error => { options.log(`Live connection error: ${safe(error.message)}`); });
      socket.once("close", (code, reason) => { closeCode = code; closeReason = reason.toString(); resolve(); });
    });
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", stop);
    if (options.signal.aborted) break;
    if ([4401, 4403, 4404, 4409].includes(closeCode)) throw new Error(closeReason || "Live subscription rejected");
    options.log(`${subscribed ? "Disconnected" : "Connection unavailable"}; reconnecting in ${backoff / 1000}s…`);
    await pause(backoff, options.signal);
    backoff = Math.min(backoff * 2, 30000);
  }
}
