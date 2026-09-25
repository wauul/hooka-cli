import type { Config } from "./config";
export interface Application { id: string; name: string; createdAt: string }
export interface Endpoint { id: string; url: string; eventTypes: string[]; circuitState: string; successRate: number | null; status?: string; environment?: string; signatureFormat?: string }
export interface Event { id: string; type: string; idempotencyKey: string }
export interface Attempt { id: string; createdAt: string; eventId: string; endpointId: string; status: string; httpStatusCode: number | null; durationMs: number | null; event: { type: string }; endpoint: { url: string; status?: string; environment?: string } }
export interface Delivery { id: string; status: string; attempts: number; endpoint: Endpoint; lastAttempt: { status: string; httpStatusCode: number | null; error: string | null } | null }
export interface EventStatus { event: Event; generation: number; deliveries: Delivery[] }
export interface AttemptPage { attempts: Attempt[]; nextCursor: string | null; hasMore: boolean }
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export class Api {
  constructor(public config: Config, private signal?: AbortSignal, private fetcher: typeof fetch = fetch) {}
  async request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    if (this.signal?.aborted) abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await this.fetcher(`${this.config.baseUrl}/api/v1/${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 401) throw new ApiError("Invalid or expired API key. Run `hooka login` again.", response.status);
      if (response.status === 403) throw new ApiError("This key's scope does not permit that operation. Use an appropriate key with `hooka login`; ingest-only keys can use send --no-wait via HOOKA_API_KEY.", response.status);
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: string };
        throw new ApiError(typeof value.error === "string" ? value.error : `API returned HTTP ${response.status}`, response.status);
      }
      try { return await response.json() as T; } catch { throw new ApiError("The server returned invalid JSON. Check your API base URL.", response.status); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (this.signal?.aborted) throw new Error("Cancelled");
      if (controller.signal.aborted) throw new Error("Request timed out after 15 seconds. Check the service and try again.");
      throw new Error("Could not reach Hooka Relay. Check your API base URL and network connection.");
    } finally { clearTimeout(timer); this.signal?.removeEventListener("abort", abort); }
  }
  me() { return this.request<{ application: Application }>("me"); }
  live() { return this.request<{ url: string }>("live"); }
  endpoints() { return this.request<{ endpoints: Endpoint[] }>("endpoints"); }
  addEndpoint(url: string, eventTypes: string[], options: Record<string, unknown> = {}) { return this.request<{ endpoint: Endpoint & { secret: string } }>("endpoints", { url, eventTypes, ...options }); }
  endpointState(id: string, action: "pause" | "resume") { return this.request<{ id: string; status: string; environment: string }>(`endpoints/${encodeURIComponent(id)}/${action}`, {}, "PATCH"); }
  configureEndpoint(id: string, options: unknown) { return this.request(`endpoints/${encodeURIComponent(id)}/configuration`, options, "PATCH"); }
  signatureFormat(id: string, signatureFormat: string) { return this.request(`endpoints/${encodeURIComponent(id)}/signature-format`, { signatureFormat }, "PATCH"); }
  rotateSecret(id: string) { return this.request<{ secret: string; previousSecretExpiresAt: string }>(`endpoints/${encodeURIComponent(id)}/rotate-secret`, {}); }
  send(customerId: string, type: string, payload: unknown, idempotencyKey?: string) { return this.request<Event>("events", { customerId, type, payload, idempotencyKey }); }
  status(id: string, generation?: number) { return this.request<EventStatus>(`events/${encodeURIComponent(id)}${generation === undefined ? "" : `?generation=${generation}`}`); }
  replay(id: string, endpointId?: string) { return this.request<{ eventId: string; generation: number; queued: number }>(`events/${encodeURIComponent(id)}/replay`, { endpointId }); }
  attempts(endpoint?: string, after?: string | null) {
    const query = new URLSearchParams();
    if (endpoint) query.set("endpoint", endpoint);
    if (after) query.set("after", after);
    return this.request<AttemptPage>(`attempts?${query}`);
  }
}
