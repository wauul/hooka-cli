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

Create an Application in the dashboard and copy its API key. `login` prompts for the base URL (default `https://hooka-relay.vercel.app`) and masks the key as you type. It validates the key with `/api/v1/me` before saving `~/.hookarc.json`. A rejected login leaves your previous configuration intact.

## Quick start

```sh
hooka fake-receiver succeed
hooka endpoints add https://hooka-relay.vercel.app/api/fake-receiver/succeed --events order.shipped
hooka send --type order.shipped --payload '{"orderId":123}'
hooka endpoints list
hooka tail
# Ctrl+C exits tail; accepted deliveries continue on the server.
```

When registering an endpoint, save the printed signing secret for HMAC verification. It is not included in endpoint list responses. Prefer `--payload-file` when shell quoting is inconvenient, especially on Windows:

```sh
hooka send --type order.shipped --payload-file payload.json
```

## Command reference

Every command has `--help` with examples. `hooka help send` also works.

| Command | Purpose |
| --- | --- |
| `hooka login [--base-url URL]` | Validate and save an Application API key |
| `hooka logout` | Delete saved credentials |
| `hooka whoami` | Show current Application ID, name and API URL |
| `hooka send --type TYPE --payload JSON` | Send an event and wait for delivery results |
| `hooka send --type TYPE --payload-file FILE` | Read a JSON payload from disk |
| `hooka send` | Prompt for type and JSON payload |
| `hooka endpoints list` | Show IDs, URLs, circuit states and 24-hour success rates |
| `hooka endpoints add URL --events TYPE,TYPE` | Register endpoint; `--events '*'` matches everything |
| `hooka tail [--endpoint ID]` | Show recent attempts and continuously poll for new ones |
| `hooka tail --once` | Show the most recent page and exit |
| `hooka replay EVENT_ID` | Queue a new delivery generation and follow it |
| `hooka fake-receiver MODE` | Print the succeed/fail/hang/flaky receiver URL |
| `hooka --version` | Print the installed package version |

`send` accepts `--idempotency-key KEY` for safe retries of event submission. Reusing a key returns the original event and its original delivery run. `send` and `replay` accept `--no-wait`, `--interval 1.5` and `--timeout SECONDS` (default 0, unlimited). A timeout stops only the local wait. Pending events keep retrying on the server. A final table shows each endpoint's status, attempt count and HTTP/error result. A failed terminal delivery exits with code 1. Cancellation exits cleanly; a cancelled in-flight request returns code 130. No endpoints is a successful accepted event with no queued deliveries.

`replay` follows the generation returned by the server, so an older successful delivery cannot falsely complete a new replay. Circuit skips do not count as HTTP attempts. A null success rate means there were no counted attempts in the last 24 hours. Colors follow `NO_COLOR` and terminal support.

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

`tail` is **polling-based**, not a push stream. It starts with the latest 100 attempts and polls every 1.5 seconds; full cursor pages are drained immediately. Output includes timestamp, event type, endpoint URL, status, HTTP code, duration and attempt ID. The cursor orders by timestamp plus ID, with bounded deduplication in the CLI. A delayed database commit behind the cursor can be missed; this is a developer view, not an authoritative audit export. Network/authentication failures exit clearly so you can reconnect; this version does not silently retry failed POST requests. An SSE feed with durable reconnect cursors is a natural v2 improvement.

The built-in fake receiver URL is informational: registering it is a separate command. This tool does not open a local tunnel or host a receiver. Endpoint mutations and replay require the companion `/api/v1` routes; the older dashboard-only API cannot authenticate those operations with an Application key.

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
