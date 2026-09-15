import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
export async function prompt(label: string, fallback?: string, secret = false, signal?: AbortSignal) {
  if (!process.stdin.isTTY) throw new Error(`Interactive input needs a terminal. Supply command options${secret ? " or HOOKA_API_KEY" : ""}.`);
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stderr.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stderr.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
    muted = secret;
    return (await rl.question("", { signal })).trim() || fallback || "";
  } finally { muted = false; rl.close(); if (secret) process.stderr.write("\n"); }
}
