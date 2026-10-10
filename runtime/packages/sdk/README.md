# @mdbase-dev/sdk

The TS SDK for mdbase-next replicas. It implements the client side of
`docs/contracts/replica-client-api.md` and is what web apps, Obsidian plugins and
scripts use instead of today's `@mdbase-dev/connect`.

The SDK implements transport, session and typed client-API boundaries.

## Layout

| Path | What |
|---|---|
| `src/cbor.ts` | Strict `mdb-cbor/1` codec (00-overview §3.2): the TS twin of `crates/wire/src/cbor.rs` |
| `src/codec.ts` | Typed struct/union/enum codecs, the TS twin of `crates/wire/src/schema.rs` |
| `src/wire.ts` | Client API messages and operations, typed (mirrors `crates/wire/src/client.rs`, `intent.rs`) |
| `src/errors.ts` | The 15 error codes and `MdbaseError` (§9) |
| `src/transport/noise.ts` | `Noise_IK_25519_ChaChaPoly_SHA256` for local IPC and relay sessions (§12.2, §12.3) |
| `src/session.ts`, `src/client.ts` | One session (frames, cancel, pushes); `MdbaseClient` (reads, live queries, writes, receipts, status, holds, conflicts, fence, reconnect) |
| `src/files.ts`, `src/presence.ts` | Files (§10) and presence (§11) |
| `src/private.ts` | Device approval and recovery key (private collections) |
| `src/keys.ts` | Client static keys: non-extractable WebCrypto X25519 in IndexedDB where possible |
| `src/transport/port.ts` | The transport seam: `FramePort`, `Connector`, `u32be` record framing |
| `src/transport/inprocess.ts` | In-process connector to a shared runtime (§12.1) |
| `src/transport/noise-session.ts` | Noise sessions over message carriers (WebSocket, `u16be`-framed streams) |
| `src/transport/relay.ts` | Relay / hosted replica connector (§12.3) |
| `src/node.ts` (`@mdbase-dev/sdk/node`) | Local IPC to the daemon (§12.2) |
| `src/testing/` (`@mdbase-dev/sdk/testing`) | `MemoryReplica` (in-memory replica speaking the protocol) and `serveNoise` |
| `test/golden.test.ts` | Runs every fixture in `conformance/wire/` from TS |

## Value model

What the SDK hands to apps, following §12.1:

| CBOR | TS |
|---|---|
| integer within ±(2^53−1) | `number` |
| integer beyond that | `bigint` |
| float with a fractional part | `number` |
| integral float (`1.0`, `-0.0`) | `Float64` (so `1` and `1.0` stay distinct) |
| byte string | `Uint8Array` |
| data map (text keys, order is data) | `Map<string, …>` |
| struct map | `Map<number, …>` at the raw level; named-field objects in the typed layer |

In the typed layer, UUIDs are canonical lowercase strings, hashes are `sha256:<hex>`
revision tokens, and enumerations are their snake_case names.

## Usage

```ts
import { connect, relayConnector, loadOrCreateClientKey } from "@mdbase-dev/sdk";

const key = await loadOrCreateClientKey("my-app");          // register key.publicKey with the grant
const db = await connect({
  app: { name: "my-app", version: "1.0.0" },
  connector: relayConnector({ collection, grant, staticKey: key, resolveRoute }),
  waitForDevice: true,                                       // private collections
});

const tasks = db.live({ types: ["task"], order_by: ["-due"], limit: 200 });   // windowed, no bodies
tasks.subscribe((s) => render(s.records, { stale: s.stale, complete: s.complete }));

const rec = await db.get(id, { body: true });
const w = await db.update(rec, { patch: { status: "done" }, body: edited }); // base + body edits filled in
w.records;                    // optimistic view now
await w.confirmed;            // at a log position, or throws MdbaseError (15 codes)

db.onStatus((s) => show(`Synced through ${s.confirmedThrough}` + (s.pending ? `, ${s.pending} waiting` : "")));
```

## Query cursor resets

`pages(query, include?, signal?, options?)` repeats the original query with the
replica's opaque cursor. By default, typed `invalid_request/fix_request` reasons
`cursor_expired` and `cursor_stale` are thrown unchanged. There is no offset
fallback or automatic mixing of already-yielded pages with a fresh query.

To opt in to **one restart per iterator**, clear your accumulated/displayed
paging state in the awaited `onReset` callback:

```ts
for await (const page of db.pages(query, include, signal, {
  onReset: async ({ reason, pagesYielded, signal }) => {
    await clearDisplayedPages(); // completes BEFORE the fresh first-page RPC
  },
})) {
  displayPage(page);
}
```

Reset clears all earlier pages even if expiry keeps the same `asOf`. The SDK
strips the cursor and preserves the captured original offset, limit, query and
include on restart. Callback failure, cancellation, or a second cursor refusal
stops the iterator. Malformed/foreign/conflicting cursors, READ denial and other
errors never trigger this callback. Native cursor lifetime/clock/head guarantees
remain the replica's responsibility; these SDK tests do not qualify that producer.

## Static key custody

Browser extensions should explicitly require non-extractable custody **before consent**:

```ts
const key = await loadOrCreateClientKey("reader", {
  storage: indexedDbKeyStorage("reader-keys"),
  requireNonExtractable: true,
});
```

Import `indexedDbKeyStorage` from the SDK. Unsupported X25519 or an existing
raw/extractable identity fails closed; existing identities are never silently
replaced. Reauthorization must be explicit. Without this option, the legacy raw
fallback remains available. Non-extractability does not prevent compromised
extension code from using DH, and is not hardware-backed custody.

Built-in stores return only committed identities and atomically choose one
first-creation winner. Custom persistent stores shared across contexts must
implement `KeyStorage.putIfAbsent`; same-store in-process creation is coalesced.
Keep the key in the extension origin, not a content script or unrestricted DH bridge.

`PLAYWRIGHT_MODULE=<module> CHROMIUM_EXECUTABLE=<browser> node scripts/keys-mv3-smoke.mjs`
runs the actual SDK in a fresh isolated MV3 profile: page/worker races, export
refusal, real DH, existing-key refusal, late IDB abort, worker wake and browser reopen.

## Checks

```sh
npm ci && npm run typecheck && npm test && npm run build && npm run size   # or: cargo xtask sdk
```
