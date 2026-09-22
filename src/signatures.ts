import { createHmac, timingSafeEqual } from "node:crypto";
import { Webhook } from "standardwebhooks";
export function verifyStandard(raw: string | Buffer, headers: Record<string, string>, secret: string): unknown {
  return new Webhook(secret).verify(raw, headers);
}
/** Legacy transition helper; no signed event ID exists in this historical format. */
export function verifyLegacy(raw: string | Buffer, signature: string, secret: string, now = Date.now()): boolean {
  const parts = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!parts || Math.abs(now / 1000 - Number(parts[1])) > 300) return false;
  const expected = createHmac("sha256", secret).update(parts[1] + ".").update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(parts[2], "hex"));
}
