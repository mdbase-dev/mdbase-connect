# SDK: working on the package

## Layout

| Path | What |
|---|---|
| `src/index.ts` (`@mdbase-dev/sdk`) | The entry for an app: `createMdbase` (which validates the app's declaration), the collection API, people, timers, notifications, holds and `describeError` |
| `src/collection-api.ts` | The collection API both entries export: client, records, files, presence, contracts, values, errors, status |
| `src/thin-client.ts` (`@mdbase-dev/sdk/thin-client`) | For code that brings its own connection (a server, a CLI, an Obsidian-plugin-style integration): the collection API plus `connect`, the Noise, relay and in-process transports, keys, the session, the wire encoding, `WasmRuntime` and availability. Never bundles manifest validation |
| `src/cbor.ts` | Strict `mdb-cbor/1` codec (00-overview §3.2): the TS twin of `crates/wire/src/cbor.rs` |
| `src/codec.ts` | Typed struct/union/enum codecs, the TS twin of `crates/wire/src/schema.rs` |
| `src/wire.ts` | Client API messages and operations, typed (mirrors `crates/wire/src/client.rs`, `intent.rs`) |
| `src/errors.ts` | The 15 error codes and `MdbaseError` (§9) |
| `src/transport/noise.ts` | `Noise_IK_25519_ChaChaPoly_SHA256` for local IPC and relay sessions (§12.2, §12.3) |
| `src/session.ts`, `src/client.ts` | One session (frames, cancel, pushes); `MdbaseClient` (reads, live queries, writes, receipts, status, holds, conflicts, fence, reconnect) |
| `src/files.ts`, `src/presence.ts` | Files (§10) and presence (§11) |
| `src/view-sources.ts` | Shared saved-view source create/update helpers over ordinary record intents |
| `src/records.ts`, `src/records/` | Shared record editor leases, bounded drafts and exact receipt recovery |
| `src/timers.ts` | Opaque control-plane timers and push channel registration (`connection.timers`) |
| `src/notifications.ts` (`@mdbase-dev/sdk/notifications`) | The push delivery envelope (`docs/contracts/push-envelope.md`) and service-worker helpers |
| `src/manifest.ts` (`@mdbase-dev/sdk/manifest`) | Build-time `mdbase-app.json` validation (`validateAppManifest`, `parseAppManifest`, `formatManifestValidationIssues`) and `MDBASE_TIMER_FIRED_CONTRACT`, using the validator Connect runs. For build scripts and tests; never needed at runtime |
| `src/describe-error.ts` (`@mdbase-dev/sdk/describe`) | `describeError()`: plain-language title, message and suggested action for any SDK error, sign-in/open problem (including `collection_migrating`, `account_suspended`, `update_required`) or readiness facet |
| `src/collection-availability.ts` | `CollectionAvailability` (`available`, `opening`, `unavailable` + reason): Private collections served by one of the account's computers, and listed cloud copies (`AppInstallationCollection.availability`, absent meaning available) |
| `src/app-grant/` (`@mdbase-dev/sdk/app-grant`) | `MdbaseAppGrants`: grants for Private collections (OAuth PKCE + an attested client Noise key), listing with availability, bounded waits, relay connector |
| `src/private.ts` | Device approval and recovery key (private collections) |
| `src/keys.ts` | Client static keys: non-extractable WebCrypto X25519 in IndexedDB where possible |
| `src/transport/port.ts` | The transport seam: `FramePort`, `Connector`, `u32be` record framing |
| `src/transport/inprocess.ts` | In-process connector to a shared runtime (§12.1) |
| `src/transport/noise-session.ts` | Noise sessions over message carriers (WebSocket, `u16be`-framed streams) |
| `src/transport/relay.ts` | Relay / hosted replica connector (§12.3) |
| `src/node.ts` (`@mdbase-dev/sdk/node`) | Local IPC to the daemon (§12.2) |
| `src/testing/` (`@mdbase-dev/sdk/testing`) | `MemoryReplica` (in-memory replica speaking the protocol) and `serveNoise` |
| `test/golden.test.ts` | Runs every fixture in `conformance/wire/` from TS |

## Checks

```sh
npm ci && npm run typecheck && npm test && npm run build && npm run bundle-boundaries   # or: cargo xtask sdk
```

`npm run bundle-boundaries` fails when either entry bundles the Ajv compiler
(manifest validators are precompiled in connect-protocol), the thin client
bundles yaml, or either bundles `app-grant`.
