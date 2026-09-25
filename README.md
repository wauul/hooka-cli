# Hooka CLI

[![CI](https://github.com/wauul/hooka-cli/workflows/CI/badge.svg)](https://github.com/wauul/hooka-cli/actions/workflows/ci.yml)

The terminal companion to [Hooka Relay](https://github.com/wauul/hooka-relay), a webhook delivery service with durable queues, retry delays, circuit breakers and HMAC signatures. Package: **hooka-relay-cli**. Command: **hooka**.

## Why I built this

Hooka Relay makes webhook delivery reliable; this CLI makes it convenient to develop against. Send a sample event, see its delivery attempts, inspect endpoint health and replay an event without leaving the terminal. The [hosted dashboard](https://hooka-relay.vercel.app) remains available for payload inspection and application administration.

## Install

Requires Node.js 18.18 or newer; Node.js 22 or 24 is recommended. The package provides both CommonJS and ESM builds, native `fetch`, Commander commands, Chalk colors, Ora spinners and cli-table3 tables.

```sh
npm install -g hooka-relay-cli
hooka --version
hooka login
hooka whoami
```

Create an application and customer in the dashboard, then copy the application API key. Pass the customer ID when sending events or adding endpoints. `login` prompts for the base URL (default `https://hooka-relay.vercel.app`) and masks the key as you type. It validates the key with `/api/v1/me` before saving `~/.hookarc.json`. A rejected login leaves your previous configuration intact.

## Quick start

```sh
hooka fake-receiver succeed
hooka customers add --external-id demo --name "Demo customer"
hooka customers list
hooka endpoints add https://hooka-relay.vercel.app/api/fake-receiver/succeed --customer-id cus_123 --events order.shipped
hooka send --customer-id cus_123 --type order.shipped --payload '{"orderId":123}'
hooka endpoints list
hooka tail
# Ctrl+C exits tail; accepted deliveries continue on the server.
```

When registering an endpoint, save the printed signing secret for HMAC verification. It is not included in endpoint list responses. Prefer `--payload-file` when shell quoting is inconvenient, especially on Windows:

```sh
hooka send --customer-id cus_123 --type order.shipped --payload-file payload.json
```

## Command reference

Every command has `--help` with examples. `hooka help send` also works.

| Command | Purpose |
| --- | --- |
| `hooka login [--base-url URL]` | Validate and save an Application API key |
| `hooka logout` | Delete saved credentials |
| `hooka whoami` | Show current Application ID, name and API URL |
| `hooka send --customer-id ID --type TYPE --payload JSON` | Send an event and wait for delivery results |
| `hooka send --customer-id ID --type TYPE --payload-file FILE` | Read a JSON payload from disk |
| `hooka send --customer-id ID` | Prompt for type and JSON payload |
| `hooka customers list` | List this application’s customers |
| `hooka customers add --external-id ID --name NAME` | Create a customer |
| `hooka endpoints list` | Show IDs, URLs, circuit states and 24-hour success rates |
| `hooka endpoints add URL --customer-id ID --events TYPE,TYPE` | Register endpoint; `--events '*'` matches everything |
| `hooka tail [--endpoint ID]` | Show recent attempts and continuously poll for new ones |
| `hooka tail --once` | Show the most recent page and exit |
| `hooka listen --source SOURCE_ID --forward-to http://localhost:3000/webhooks` | Forward verified provider webhooks to a local server live |
| `hooka replay EVENT_ID` | Queue a new delivery generation and follow it |
| `hooka fake-receiver MODE` | Print the succeed/fail/hang/flaky receiver URL |
| `hooka --version` | Print the installed package version |

`send` requires `--customer-id ID` and accepts `--idempotency-key KEY` for safe retries of event submission. Reusing a key returns the original event and its original delivery run. `send` and `replay` accept `--no-wait`, `--interval 1.5` and `--timeout SECONDS` (default 0, unlimited). A timeout stops only the local wait. Pending events keep retrying on the server. A final table shows each endpoint's status, attempt count and HTTP/error result. A failed terminal delivery exits with code 1. Cancellation exits cleanly; a cancelled in-flight request returns code 130. No endpoints is a successful accepted event with no queued deliveries.

`replay` follows the generation returned by the server, so an older successful delivery cannot falsely complete a new replay. Circuit skips do not count as HTTP attempts. A null success rate means there were no counted attempts in the last 24 hours. Colors follow `NO_COLOR` and terminal support.

### Receive provider webhooks locally

Create an inbound source in the Hooka dashboard and register its ingestion URL with the provider. The source may have a public destination, a local listener, or both. Then run:

```sh
hooka listen --source SOURCE_ID --forward-to http://localhost:3000/webhooks
```

`--source` also accepts a unique source name within the Application. The CLI authenticates with your saved Application API key, opens a WSS connection to Hooka's worker, and forwards each verified request to localhost with its original body bytes and provider signature headers. `Host`, `Content-Length`, and hop-by-hop headers are generated for the local connection. Each line reports event type, local HTTP status or error, and latency. Connection loss triggers backoff and reconnection; Ctrl+C closes the session. A stopped local server produces an error for that event while the listener stays open. Open the source event log in the dashboard to inspect failed requests or replay a saved verified request.

Self-hosted deployments can override the relay advertised by the API with `--tunnel-url wss://worker.example/live`; `ws://` is allowed for localhost only. The web app must publish `TUNNEL_PUBLIC_URL` with that public WSS address.

## Configuration and security

The config file is plaintext; Unix file permissions are restricted to the owner (0600). On Windows it inherits your user-directory ACLs. Do not commit this file. `HOOKA_CONFIG` selects an alternate config path, useful for scripts and isolated tests.

For noninteractive environments, provide `HOOKA_API_KEY` and optionally `HOOKA_BASE_URL`; these override saved configuration. `hooka login --base-url URL` can validate and save an environment key without prompting. `logout` removes the config file but cannot unset environment variables inherited from your shell. Unset them separately. API keys are never printed by login or whoami.

HTTPS is required except for `localhost`, `127.0.0.1` or `::1` development servers. HTTP redirects are not followed with credentials. Requests time out after 15 seconds. Terminal control characters in server-supplied fields are stripped before display. Endpoint secrets are intentionally printed only when you create an endpoint.

## API contract and polling limitations

The companion routes added to Hooka Relay use Application API-key authentication and never accept another Application's resources, even if the same user owns both Applications:

| Method | Route |
| --- | --- |
| GET | `/api/v1/me` |
| GET/POST | `/api/v1/endpoints` |
| POST | `/api/v1/events` |
| GET | `/api/v1/events/:id?generation=N` |
| GET | `/api/v1/attempts?endpoint=ID&after=CURSOR` |
| POST | `/api/v1/events/:id/replay` |
| GET | `/api/v1/live` (relay discovery) |

`tail` is **polling-based**, not a push stream. It starts with the latest 100 attempts and polls every 1.5 seconds; full cursor pages are drained immediately. Output includes timestamp, event type, endpoint URL, status, HTTP code, duration and attempt ID. The cursor orders by timestamp plus ID, with bounded deduplication in the CLI. A delayed database commit behind the cursor can be missed; this is a developer view, not an authoritative audit export. Network/authentication failures exit clearly so you can reconnect; this version does not silently retry failed POST requests. An SSE feed with durable reconnect cursors is a natural v2 improvement.

The built-in fake receiver URL is informational: registering it is a separate command. `listen` forwards over the existing worker connection; it does not expose a local port directly to the public internet. Endpoint mutations and replay require the companion `/api/v1` routes; the older dashboard-only API cannot authenticate those operations with an Application key.

## Development and tests

Use Node.js 22+ for development (the published runtime supports 18.18+):

```sh
npm ci
npm run check
npm run test:coverage
npm link
hooka --help
```

Vitest tests exercise config permissions and persistence, HTTP authentication and errors, payload parsing, generation-aware waits, cancellation, paginated tail deduplication and all commands against a local HTTP test server. The separate Hooka Relay suite verifies the real API with disposable PostgreSQL and cross-Application isolation. CI packs the actual distribution and tests global installation plus CommonJS/ESM imports on Linux Node 18/20/24 and Windows Node 22. No hosted credentials are required for CI tests.

## Releases

Public npm publishing is free. `publish.yml` runs checks and publishes with provenance when a version tag is pushed. It uses npm trusted publishing (GitHub OIDC), so no long-lived `NPM_TOKEN` is needed. Configure npm's trusted publisher for owner `wauul`, repository `hooka-cli`, workflow `publish.yml`, no environment, with direct publishing allowed. The initial package is bootstrapped through an authenticated local npm login; subsequent tags use that trusted relationship.

```sh
npm version patch
git push origin main --follow-tags
```

The workflow checks that the tag and package version agree. A rerun of an already published version verifies its registry entry and skips republishing; this also supports the initial v1.0.0 tag after the authenticated bootstrap. npm versions are immutable; publish a new version for subsequent fixes. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for account-side setup.

## License

MIT. See [LICENSE](LICENSE).
## Version 2: lifecycle and Standard Webhooks

New endpoints use Standard Webhooks: `webhook-id` is the stable event ID, and `webhook-timestamp` plus the raw body are signed in `webhook-signature`. Use the endpoint’s displayed `whsec_` secret to verify each delivery:

```sh
hooka endpoints signature-format ENDPOINT_ID STANDARD
hooka endpoints rotate-secret ENDPOINT_ID
hooka endpoints pause ENDPOINT_ID
hooka endpoints resume ENDPOINT_ID
hooka endpoints add https://example.com/webhook --environment staging
hooka endpoints configure ENDPOINT_ID --file endpoint-config.json
hooka backlog --since 2026-09-01T00:00:00Z --endpoint ENDPOINT_ID
hooka recover --since 2026-09-01T00:00:00Z --endpoint ENDPOINT_ID
hooka replay EVENT_ID --endpoint ENDPOINT_ID
hooka event-types list
hooka event-types publish event-type.json
hooka docs
```

Signing rotation prints the new secret and old-secret expiry (seven-day grace by default). During grace either key verifies. Another rotation during grace returns 409. `configure` accepts environment, kind (`BUSINESS`/`OPERATIONAL`), customHeaders, deliveryRatePerMinute and transform; omit fields to retain their values. Headers and transform are validated server-side. See the [interactive API reference](https://hooka-relay.vercel.app/docs#api-reference) for exact schemas and limits.

`PAUSED` stops new delivery intents and attempts; resume does not backfill missed events. `DISABLED` exposes the open circuit while automatic recovery probes remain intact. Backlog is paginated; use `--cursor` from `nextCursor`. Bulk recovery creates a durable paced job for latest failed deliveries. Events are not ordered across retries.

To verify a captured request locally, set `HOOKA_SIGNING_SECRET` and run `hooka verify --payload-file body.json --headers-file headers.json`. Pass exact raw bytes, not reserialized JSON. Use `--legacy` for historical signatures. Standard verification uses the official reference library, authenticates the event ID and checks the five-minute timestamp window. Verification never sends the secret to Hooka Relay. Deduplicate verified IDs with business changes.

Read-only keys support inspection. Ingest-only keys deliberately cannot call `whoami` or poll delivery logs: set `HOOKA_API_KEY` and use `hooka send --no-wait`. Manage endpoints, replay, catalog or recovery with an existing unscoped application key. Scoped-key creation/revocation remains in the dashboard. API keys never appear in the docs URL.
