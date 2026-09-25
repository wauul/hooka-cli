import { Webhook } from "standardwebhooks";
export function verifyStandard(raw: string | Buffer, headers: Record<string, string>, secret: string): unknown {
  return new Webhook(secret).verify(raw, headers);
}
