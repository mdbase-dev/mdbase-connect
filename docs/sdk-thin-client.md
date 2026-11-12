# SDK: bringing your own connection

For code that makes its own connection: a server, a CLI, a plugin that talks to
the desktop daemon. An app calls `createMdbase` instead; see the
[package README](../runtime/packages/sdk/README.md).
[Which entry to import](sdk-entries.md) lists what each entry exports.

## Usage

```ts
import { connect, relayConnector, loadOrCreateClientKey } from "@mdbase-dev/sdk/thin-client";

const key = await loadOrCreateClientKey("my-app");          // register key.publicKey with the grant
const db = await connect({
  app: { name: "my-app", version: "1.0.0" },
  connector: relayConnector({ collection, grant, staticKey: key, resolveRoute }),
  waitForDevice: true,                                       // private collections
});

const tasks = db.recordSet({ types: ["task"] });            // every task, kept current
tasks.subscribe(() => render(tasks.getSnapshot()));

const rec = await db.get(id, { include: { body: true } });
const w = await db.update(rec, { patch: { status: "done" }, body: edited }); // base + body edits filled in
w.records;                    // optimistic view now
await w.confirmed;            // at a log position, or throws MdbaseError (15 codes)

db.onStatus((s) => show(`Synced through ${s.confirmedThrough}` + (s.pending ? `, ${s.pending} waiting` : "")));
```

`await db.create(input)` returns a `RecordWrite`, the existing tracked `Write`
with an added `recordId`. It is the submitted UUID, available even when the
receipt has no optimistic records. Contract creates and retries with the same
`intent` return that same identity. Confirmation/publication semantics are unchanged.
`update`, `replaceDocument`, `rename` and `delete` set `write.recordId` too.

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
