import { readFile, writeFile, rename, mkdir, chmod, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_URL = "https://hooka-relay.vercel.app";
export interface Config { baseUrl: string; apiKey: string }
export function configPath() { return process.env.HOOKA_CONFIG || join(homedir(), ".hookarc.json"); }
export function normalizeUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Enter a valid API base URL, such as " + DEFAULT_URL); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("Use HTTPS (HTTP is allowed only for localhost), without credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}
export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || typeof c.baseUrl !== "string" || typeof c.apiKey !== "string" || !/^[\x21-\x7e]{1,512}$/.test(c.apiKey)) throw new Error("Invalid configuration. Run `hooka login` again.");
  return { baseUrl: normalizeUrl(c.baseUrl), apiKey: c.apiKey };
}
export async function loadConfig(path = configPath()): Promise<Config> {
  if (process.env.HOOKA_API_KEY) return validateConfig({ apiKey: process.env.HOOKA_API_KEY, baseUrl: process.env.HOOKA_BASE_URL || DEFAULT_URL });
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Refusing a symbolic-link config file.");
    const value = JSON.parse(await readFile(path, "utf8"));
    return validateConfig(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Not logged in. Run `hooka login` first.");
    if (error instanceof SyntaxError) throw new Error("Configuration contains invalid JSON. Run `hooka login` again.");
    throw error;
  }
}
export async function saveConfig(value: Config, path = configPath()) {
  const config = validateConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function clearConfig(path = configPath()) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
