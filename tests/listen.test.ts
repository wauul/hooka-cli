import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { forwardLocal, liveUrl, localForwardUrl } from "../src/listen";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

it("forwards the original bytes and provider headers to localhost", async () => {
  const body = Buffer.from([0, 1, 2, 127, 128, 255]);
  let received: { body: Buffer; signature: string | undefined; host: string | undefined } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = { body: Buffer.concat(chunks), signature: request.headers["stripe-signature"] as string | undefined, host: request.headers.host };
    response.writeHead(204); response.end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const result = await forwardLocal({ type: "event", attemptId: "a", receiptId: "r", replayId: null, eventType: "payment.created", receivedAt: new Date().toISOString(), headers: { "stripe-signature": "t=1,v1=abc", host: "provider.example", "content-length": "999" }, bodyBase64: body.toString("base64") }, `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`);
  expect(result.status).toBe(204);
  expect(received?.body).toEqual(body);
  expect(received?.signature).toBe("t=1,v1=abc");
  expect(received?.host).toMatch(/^127\.0\.0\.1:/);
});

it("rejects nonlocal forwarding and insecure remote relay addresses", () => {
  expect(() => localForwardUrl("https://example.com/webhook")).toThrow();
  expect(() => liveUrl("ws://relay.example/live")).toThrow();
  expect(liveUrl("wss://relay.example/live")).toBe("wss://relay.example/live");
});
