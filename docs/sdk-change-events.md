# Collection change events

The client normalizes existing authority changes; this feature adds no new wire
operation, capability requirement, authorization rule, or protocol version.
The unchanged version-3 `CollectionChange` envelope accepts arbitrary event IDs
and payloads. `packages/protocol/schemas/change-events.v1.json` describes known
IDs and optional metadata. `pnpm generate:changes` generates the Rust and
TypeScript payload definitions and classification tables; protocol tests check
that generated files are current and Rust decodes the shared fixtures.

Client [`CollectionChange`](../packages/client/src/operation-types.ts) is a
`kind`-discriminated union. [`normalizeCollectionChange`](../packages/client/src/change-events.ts)
is its single conversion boundary for both history and watching. Known payloads
with absent required identity or malformed supplied metadata become `unknown`
with `reason: "invalid_payload"`. Unknown IDs use `reason: "unrecognized_type"`.
Raw data stays reachable in either case. Optional/null metadata on older
connectors remains absent: no capability probe or error-based fallback is needed.

## Producer evidence

[`collection-changes-v1.json`](../packages/protocol/test/fixtures/collection-changes-v1.json)
contains deterministic payload captures checked directly against the emitters:

- Local: `watch_event` in
  `crates/connect-core/src/registry/runtime_changes.rs`. The fixture test feeds
  canonical record/resource transitions through the real emitter and asserts
  exact event ID and payload equality, including runtime metadata.
- Hosted: `application_change` in
  `crates/connect-hosted-provider/src/provider/policy.rs`. The fixture test feeds
  before/after `SyncRecord` projections through the real emitter and asserts
  exact event ID and payload equality. These tests need no live deployment or
  database and do not change authority behaviour.
- The `files` cases exercise the existing file descriptor/identity shapes and
  editor's accepted file event IDs; they are **not** evidence that both authority
  application feeds currently publish rich file descriptors. Local managed
  resources publish `mdbase.resource.changed` (normalized to `file.changed`).
  Hosted saved-view resources use `mdbase.view_source.changed`; local resources
  use `mdbase.view.changed`. The `file_put`/`file_remove` aliases preserve the
  editor's existing acceptance of sync-derived file adapters. Remove these
  aliases when those adapters no longer submit sync IDs as collection events;
  they do not imply new application-feed emission by either authority.

Local `changed_fields` are canonical JSON Pointers; hosted `changed_fields` are
frontmatter keys. `changedFields` preserves that distinction rather than guessing
nested semantics. Local deletion reports empty after-state `types` and separate
`previous_types`; hosted deletion currently puts deleted-record membership in
`types`. Frontmatter and `bodyChanged` are optional for the same reason. Use an
authoritative read when the payload cannot prove the required current state.

## Description lifecycle

Each collection client owns one successful description and one in-flight load.
The settled cache lives for at most 60 seconds. Fresh calls bypass settled state
but join an existing load. Waiter cancellation/timeouts do not cancel another
waiter; the shared load has the connection's configured request budget. Failed
loads are evicted, including failed fresh loads. A local invalidation generation
fences loads begun before schema events, unknown events or gaps. History replay
of the same invalidation cursor does not advance generation again. Accepted
schema mutations invalidate even without watching.

This cache is not an observer: it does not start a background feed. Applications
must watch to get immediate invalidation or use `describe({ fresh: true })` for
correctness-critical refreshes. `schemaGeneration` is scoped to this client, not
a persisted authority schema version. Treat returned descriptions as read-only;
cache hits share the same description object. A cached description is metadata,
not authorization evidence; the authority still checks every filesystem request.

## Architecture review

The reviewed architecture counts account for five source modules: generated Rust
and TS wire metadata, the client change-normalization boundary, the description
cache lifecycle, and a canonical file descriptor/type mapper. The latter two move
existing normalization out of the operation/file facades rather than duplicate
it. These boundaries keep operation files below the unchanged 1,000-line ceiling
and avoid type-barrel/import cycles. Rust public declarations increase by 25 for
the generated structs, fields and classifier; no authority code calls a new
mutation or emits a new event. There are no new workspace packages, capabilities,
configured settings or persisted state. The editor's raw-ID filter and descriptor
parser are deleted in favour of the single SDK normalizer.

See the [client migration notes](../packages/client/README.md#typed-changes-and-description-caching)
for raw-consumer and custom-emitter migration, and unchanged terminal watch reset
handling.
