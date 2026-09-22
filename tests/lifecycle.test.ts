import { expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { Api } from "../src/api";
import { verifyStandard, verifyLegacy } from "../src/signatures";
import { createProgram } from "../src/program";
import { endpointTable, attemptLine } from "../src/output";

it("uses scoped, encoded PATCH routes for pause/resume/configuration", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ id: "ep", status: "PAUSED", environment: "staging" }));
  const api = new Api({ baseUrl: "https://example.com", apiKey: "key" }, undefined, fetcher);
  await api.endpointState("ep/other", "pause"); await api.endpointState("ep", "resume"); await api.configureEndpoint("ep", { environment: "test" });
  expect(fetcher.mock.calls[0][0]).toBe("https://example.com/api/v1/endpoints/ep%2Fother/pause");
  expect(fetcher.mock.calls.every(call => call[1].method === "PATCH")).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ environment: "test" });
});
it("opens docs without logging in or leaking a key into the URL", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  await createProgram({ open, log: vi.fn() }).parseAsync(["docs", "--base-url", "https://example.com"], { from: "user" });
  expect(open).toHaveBeenCalledWith("https://example.com/docs#api-reference");
});
it("verifies Standard Webhooks rotation and signed ID, retaining legacy verification", () => {
  const secret = "whsec_" + Buffer.alloc(32, 4).toString("base64"), oldSecret = "whsec_" + Buffer.alloc(32, 3).toString("base64");
  const raw = '{"ok":true}', now = new Date(), id = "event-stable";
  const headers = { "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime()/1000)), "webhook-signature": [secret, oldSecret].map(key => new Webhook(key).sign(id, now, raw)).join(" ") };
  for (const key of [secret, oldSecret]) expect(verifyStandard(raw, headers, key)).toEqual({ ok: true });
  expect(() => verifyStandard(raw, { ...headers, "webhook-id": "forged" }, secret)).toThrow();
  const signature = `t=${headers["webhook-timestamp"]},v1=${createHmac("sha256", "legacy").update(headers["webhook-timestamp"] + "." + raw).digest("hex")}`;
  expect(verifyLegacy(raw, signature, "legacy")).toBe(true);
  expect(verifyLegacy(raw, signature, "legacy", Date.now()+600_000)).toBe(false);
  expect(verifyLegacy(raw + " ", signature, "legacy")).toBe(false);
});
it("renders environment and effective endpoint status safely", () => {
  const ep = { id: "ep", url: "https://example.com", status: "PAUSED", environment: "staging", circuitState: "CLOSED", eventTypes: ["*"], successRate: null };
  expect(endpointTable([ep])).toContain("PAUSED"); expect(endpointTable([ep])).toContain("staging");
  expect(attemptLine({ id: "a", eventId: "e", endpointId: "ep", createdAt: "now", event: { type: "test" }, endpoint: ep, status: "SUCCESS", httpStatusCode: 200, durationMs: 1 })).toContain("PAUSED  staging");
});
