import { Command, InvalidArgumentError } from "commander";
import { readFile } from "node:fs/promises";
import ora from "ora";
import { Api } from "./api";
import { clearConfig, DEFAULT_URL, loadConfig, normalizeUrl, saveConfig, validateConfig } from "./config";
import { endpointTable, statusTable, attemptLine, safe } from "./output";
import { waitForEvent, tailAttempts } from "./poll";
import { prompt } from "./prompt";
import { version } from "../package.json";
import { openBrowser } from "./browser";
import { verifyStandard } from "./signatures";
import { listen } from "./listen";

function positive(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 60) throw new InvalidArgumentError("Use a number between 1 and 60 seconds.");
  return n;
}
function timeout(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("Timeout must be a non-negative number of seconds (0 means unlimited).");
  return n;
}
export function parsePayload(value: string) {
  try { return JSON.parse(value) as unknown; } catch { throw new Error("Malformed JSON payload. Use valid JSON, for example '{\"orderId\":123}'."); }
}
export interface Dependencies { signal?: AbortSignal; log?: (message: string) => void; ask?: typeof prompt; open?: typeof openBrowser }
export function createProgram(dependencies: Dependencies = {}) {
  const signal = dependencies.signal || new AbortController().signal;
  const log = dependencies.log || console.log;
  const ask = dependencies.ask || prompt;
  const program = new Command().name("hooka").description("Your terminal companion for Hooka Relay webhooks").version(version).showHelpAfterError();
  const api = async () => new Api(await loadConfig(), signal);
  const help = (command: Command, examples: string) => command.addHelpText("after", `\nExamples:\n${examples}\n`);
  program.command("docs").description("Open the interactive API reference").option("--base-url <url>", "Deployment URL").action(async options => {
    let base = options.baseUrl || process.env.HOOKA_BASE_URL;
    if (!base) { try { base = (await loadConfig()).baseUrl; } catch (error) { if (!(error instanceof Error) || !error.message.startsWith("Not logged in")) throw error; base = DEFAULT_URL; } }
    const url = normalizeUrl(base) + "/docs#api-reference";
    log(url); await (dependencies.open || openBrowser)(url).catch(() => log("Open the URL above in your browser."));
  });
  program.command("verify").description("Verify a captured webhook locally without sending secrets").requiredOption("--payload-file <file>", "Exact raw request body").requiredOption("--headers-file <file>", "JSON object containing request headers").action(async options => {
    const raw = await readFile(options.payloadFile);
    const headers = JSON.parse(await readFile(options.headersFile, "utf8"));
    const secret = process.env.HOOKA_SIGNING_SECRET || await ask("Signing secret", undefined, true, signal);
    const normalized = Object.fromEntries(Object.entries(headers).map(([k,v]) => { if (typeof v !== "string") throw new Error("Header values must be strings"); return [k.toLowerCase(), v]; }));
    verifyStandard(raw, normalized, secret);
    log(`Standard Webhooks signature verified. Signed event ID: ${safe(normalized["webhook-id"])}`);
  });
  async function follow(client: Api, id: string, options: { wait?: boolean; interval: number; timeout: number }, generation?: number) {
    if (options.wait === false) return;
    const spinner = ora({ text: "Waiting for delivery attempts…", isEnabled: !!process.stderr.isTTY, isSilent: !process.stderr.isTTY }).start();
    let previous = "";
    try {
      const status = await waitForEvent(client, id, { signal, interval: options.interval * 1000, timeout: options.timeout * 1000, generation,
        update(value) {
          const summary = value.deliveries.map(d => `${safe(d.endpoint.url)}: ${safe(d.status)} (${d.attempts} attempts)`).join(" | ");
          if (process.stderr.isTTY) spinner.text = summary || "No matching endpoints";
          else if (summary !== previous) { log(summary); previous = summary; }
        },
      });
      spinner.stop();
      log(statusTable(status));
      if (status.deliveries.some(d => d.status === "DEAD_LETTERED")) throw new Error("One or more deliveries exhausted their retries.");
    } finally { spinner.stop(); }
  }
  const waiting = (command: Command) => command.option("--no-wait", "Return after the event is accepted").option("--interval <seconds>", "Polling interval", positive, 1.5).option("--timeout <seconds>", "Stop waiting after this duration; 0 waits until terminal status", timeout, 0);

  help(program.command("login").description("Validate an application API key and save local configuration")
    .option("--base-url <url>", "API base URL (defaults to the deployed service)")
    .action(async options => {
      const baseUrl = normalizeUrl(options.baseUrl || await ask("API base URL", DEFAULT_URL, false, signal));
      const apiKey = process.env.HOOKA_API_KEY || await ask("Application API key", undefined, true, signal);
      const config = validateConfig({ baseUrl, apiKey });
      const result = await new Api(config, signal).me();
      if (!result.application?.id) throw new Error("Server did not return application information. Check the API base URL.");
      await saveConfig(config);
      log(`Logged in to ${safe(result.application.name)} (${safe(result.application.id)}) at ${safe(baseUrl)}.`);
    }), "  hooka login\n  hooka login --base-url http://localhost:3000");
  help(program.command("logout").description("Delete the saved API key and base URL").action(async () => {
    await clearConfig(); log("Saved configuration removed.");
    if (process.env.HOOKA_API_KEY) log("HOOKA_API_KEY is still set in your environment; unset it to fully log out.");
  }), "  hooka logout");
  help(program.command("whoami").description("Show the application associated with your API key").action(async () => {
    const client = await api(); const { application } = await client.me();
    log(`${safe(application.name)}\nApplication: ${safe(application.id)}\nAPI: ${safe(client.config.baseUrl)}`);
  }), "  hooka whoami");
  help(waiting(program.command("send").description("Send an event and follow its delivery run")
    .requiredOption("--customer-id <id>", "Customer ID in this application")
    .option("--type <type>", "Event type, such as order.shipped")
    .option("--payload <json>", "Inline JSON payload")
    .option("--payload-file <file>", "Read JSON payload from a file")
    .option("--idempotency-key <key>", "Reuse a key to safely retry event submission"))
    .action(async options => {
      if (options.payload !== undefined && options.payloadFile) throw new Error("Choose either --payload or --payload-file, not both.");
      if (!options.customerId.trim() || options.customerId.length > 100) throw new Error("--customer-id must contain 1–100 characters.");
      const type = options.type || await ask("Event type", undefined, false, signal);
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(type)) throw new Error("Event type must contain 1–120 letters, digits, dots, underscores, colons or hyphens.");
      let raw: string;
      if (options.payloadFile) {
        try { raw = await readFile(options.payloadFile, "utf8"); } catch { throw new Error(`Could not read payload file: ${safe(options.payloadFile)}`); }
      } else raw = options.payload ?? await ask("JSON payload", "{}", false, signal);
      const payload = parsePayload(raw.replace(/^\uFEFF/, ""));
      if (Buffer.byteLength(JSON.stringify({ customerId: options.customerId, type, payload, idempotencyKey: options.idempotencyKey })) > 262144) throw new Error("Event exceeds the API's 256 KB limit.");
      const client = await api(); const event = await client.send(options.customerId, type, payload, options.idempotencyKey);
      log(`Event accepted: ${safe(event.id)}\nIdempotency key: ${safe(event.idempotencyKey)}\nStandard Webhooks ID: ${safe(event.id)}`);
      await follow(client, event.id, options, 0);
    }), "  hooka send --customer-id cus_123 --type order.shipped --payload '{\"orderId\":123}'\n  hooka send --customer-id cus_123 --type order.shipped --payload-file payload.json\n  hooka send --customer-id cus_123");
  const customers = program.command("customers").description("List and create customers in this application");
  customers.command("list").description("List customer IDs and names").action(async () => {
    const client = await api(); const { application } = await client.me();
    log(safe(JSON.stringify(await client.request(`applications/${encodeURIComponent(application.id)}/customers`), null, 2)));
  });
  customers.command("add").description("Create a customer").requiredOption("--external-id <id>", "Your stable customer reference").requiredOption("--name <name>", "Display name").action(async options => {
    const client = await api(); const { application } = await client.me();
    log(safe(JSON.stringify(await client.request(`applications/${encodeURIComponent(application.id)}/customers`, { externalId: options.externalId, name: options.name }), null, 2)));
  });
  const endpoints = help(program.command("endpoints").description("Inspect and register application webhook endpoints"), "  hooka endpoints list\n  hooka endpoints add https://example.com/webhook --customer-id cus_123 --events order.shipped");
  program.command("backlog").description("Pull a page of missed events").option("--since <timestamp-or-id>").option("--endpoint <id>").option("--cursor <cursor>").option("--limit <number>", "Page size, 1–100", "50").action(async options => {
    const client = await api(), { application } = await client.me();
    const query = new URLSearchParams({ limit: options.limit });
    for (const [name, value] of [["since", options.since], ["endpoint_id", options.endpoint], ["cursor", options.cursor]]) if (value) query.set(name, value);
    log(safe(JSON.stringify(await client.request(`applications/${encodeURIComponent(application.id)}/events?${query}`), null, 2)));
  });
  program.command("recover").description("Queue paced bulk recovery of failed deliveries").requiredOption("--since <timestamp>", "ISO timestamp").option("--endpoint <id>").action(async options => {
    const client = await api(), { application } = await client.me();
    log(safe(JSON.stringify(await client.request(`applications/${encodeURIComponent(application.id)}/recovery`, { since: options.since, endpointId: options.endpoint }))));
  });
  const catalog = program.command("event-types").description("Versioned application event catalog");
  catalog.command("list").action(async () => { const client = await api(), { application } = await client.me(); log(safe(JSON.stringify(await client.request(`applications/${encodeURIComponent(application.id)}/event-types`)))); });
  catalog.command("publish <file>").description("Publish JSON {eventType,description,schema?}").action(async file => { const input = parsePayload(await readFile(file, "utf8")); const client = await api(), { application } = await client.me(); log(safe(JSON.stringify(await client.request(`applications/${encodeURIComponent(application.id)}/event-types`, input)))); });
  for (const action of ["pause", "resume"] as const) endpoints.command(`${action} <id>`).description(`${action} endpoint delivery`).action(async id => { const state = await (await api()).endpointState(id, action); log(`${safe(state.id)}: ${safe(state.status)} (${safe(state.environment)})`); if (action === "resume") log("Events missed while paused require explicit replay."); });
  endpoints.command("configure <id>").description("Update environment, kind, headers, throttle or transform from JSON").requiredOption("--file <file>", "Endpoint configuration JSON").action(async (id, options) => { await (await api()).configureEndpoint(id, parsePayload(await readFile(options.file, "utf8"))); log("Endpoint configuration updated."); });
  endpoints.command("rotate-secret <id>").description("Rotate signing secret with seven-day grace by default").action(async id => { const result = await (await api()).rotateSecret(id); log(`New signing secret: ${safe(result.secret)}\nOld secret remains valid until ${safe(result.previousSecretExpiresAt)}. Update your receiver before then.`); });
  help(endpoints.command("list").description("List endpoints, circuit states and 24-hour success rates").action(async () => {
    log(endpointTable((await (await api()).endpoints()).endpoints));
  }), "  hooka endpoints list");
  help(endpoints.command("add <url>").description("Register an endpoint and display its signing secret")
    .requiredOption("--customer-id <id>", "Customer ID that owns this endpoint")
    .option("--events <types>", "Comma-separated event types, or * for all", "*")
    .option("--environment <name>", "Freeform environment label")
    .action(async (url, options) => {
      if (!options.customerId.trim() || options.customerId.length > 100) throw new Error("--customer-id must contain 1–100 characters.");
      const eventTypes = [...new Set<string>(options.events.split(",").map((s: string) => s.trim()))];
      if (!eventTypes.length || eventTypes.some(type => !/^(\*|[A-Za-z0-9_.:-]{1,120})$/.test(type))) throw new Error("--events must contain comma-separated event types, or *.");
      const { endpoint } = await (await api()).addEndpoint(url, eventTypes, { customerId: options.customerId, ...(options.environment ? { environment: options.environment } : {}) });
      log(`Endpoint created: ${safe(endpoint.id)}\nURL: ${safe(endpoint.url)}\nSigning secret: ${safe(endpoint.secret)}\nSave this secret for HMAC verification. Treat it as a password.`);
    }), "  hooka endpoints add https://example.com/webhook --customer-id cus_123 --events order.shipped,order.cancelled\n  hooka endpoints add https://hooka-relay.vercel.app/api/fake-receiver/succeed --customer-id cus_123 --events '*'");
  help(program.command("tail").description("Poll delivery attempts and print new entries (Ctrl+C stops)")
    .option("--endpoint <id>", "Only show attempts for this endpoint")
    .option("--interval <seconds>", "Polling interval", positive, 1.5)
    .option("--once", "Print the most recent page and exit")
    .action(async options => {
      log("Timestamp  Event type  Endpoint  Endpoint status  Environment  Delivery status  HTTP  Duration  Attempt ID");
      await tailAttempts(await api(), { signal, interval: options.interval * 1000, endpoint: options.endpoint, once: options.once, print: attempt => log(attemptLine(attempt)) });
    }), "  hooka tail\n  hooka tail --endpoint cl_example\n  hooka tail --once");
  help(program.command("listen").description("Forward verified inbound webhooks to a local server")
    .requiredOption("--source <id-or-name>", "Webhook source ID or unambiguous name")
    .requiredOption("--forward-to <local-url>", "Localhost HTTP(S) destination")
    .option("--tunnel-url <ws-url>", "Override the live relay URL for local testing")
    .action(async options => {
      const config = await loadConfig();
      await listen(new Api(config, signal), options.source, options.forwardTo, { signal, log, tunnelUrl: options.tunnelUrl });
      log("Live forwarding stopped.");
    }), "  hooka listen --source stripe-dev --forward-to http://localhost:3000/webhooks\n  hooka listen --source cl_source_id --forward-to http://127.0.0.1:3000/webhooks");
  help(waiting(program.command("replay <eventId>").description("Replay an event to active matching endpoints and follow the new run").option("--endpoint <id>", "Replay only to this matching endpoint"))
    .action(async (eventId, options) => {
      const client = await api(); const spinner = ora({ text: "Queuing replay…", isEnabled: !!process.stderr.isTTY, isSilent: !process.stderr.isTTY }).start();
      let result;
      try { result = await client.replay(eventId, options.endpoint); } finally { spinner.stop(); }
      log(`Replay queued: ${safe(result.eventId)} (generation ${result.generation}, ${result.queued} endpoints)`);
      await follow(client, result.eventId, options, result.generation);
    }), "  hooka replay cl_event_id\n  hooka replay cl_event_id --no-wait");
  help(program.command("fake-receiver <mode>").description("Print the built-in succeed/fail/hang/flaky receiver URL")
    .option("--base-url <url>", "Override the saved API base URL")
    .action(async (mode, options) => {
      if (!["succeed", "fail", "hang", "flaky"].includes(mode)) throw new Error("Mode must be succeed, fail, hang or flaky.");
      let baseUrl = options.baseUrl || process.env.HOOKA_BASE_URL;
      if (!baseUrl) {
        try { baseUrl = (await loadConfig()).baseUrl; } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("Not logged in")) throw error;
          baseUrl = DEFAULT_URL;
        }
      }
      log(`${normalizeUrl(baseUrl)}/api/fake-receiver/${mode}`);
    }), "  hooka fake-receiver flaky\n  hooka fake-receiver succeed --base-url http://localhost:3000");
  return program;
}
