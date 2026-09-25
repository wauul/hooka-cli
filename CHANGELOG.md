# Changelog

## 3.0.0

- Require a customer ID when sending events or registering endpoints, matching Hooka Relay customer isolation.
- Add `hooka customers list` and `hooka customers add` to create and find customer IDs.
- Remove the obsolete endpoint signing-format command.

## 2.1.0

- Add `hooka listen` to forward verified inbound provider webhooks to localhost over the worker's live WebSocket relay.
- Preserve provider body bytes and signature headers, report local response status and latency, and reconnect automatically after connection loss.
- Support source IDs or unique source names and an optional `--tunnel-url` for self-hosted workers.

## 2.0.0

- New endpoints default to Standard Webhooks. Existing endpoints retain LEGACY until explicitly migrated; `verify` supports both formats.
- Add endpoint pause/resume, configuration, signing-secret rotation and signing-format commands.
- Add backlog, paced bulk recovery and versioned event catalog commands.
- Show endpoint status/environment in endpoint lists and delivery tails; support targeted replay.
- Add `hooka docs` for interactive API documentation. Explain scoped-key permission failures without treating every 403 as an expired key.

The major version reflects the changed signing default for newly registered endpoints. Existing saved configurations, event IDs, idempotency behavior, retry scheduling and legacy receivers remain compatible.
