# @mdbase-dev/sdk

`@mdbase-dev/sdk` on npmjs contains production trust only. Staging/LAB use
separately attested, version-pinned GitHub prerelease assets, not npm packages
published to a registry. Publication uses the exact production-verified release
tag and version; see
[`docs/sdk-publication.md`](../../../docs/sdk-publication.md).

The TS SDK for mdbase-next replicas. It implements the client side of
`docs/contracts/replica-client-api.md` and is what web apps, Obsidian plugins and
scripts use instead of today's `@mdbase-dev/connect`.

The SDK implements transport, session and typed client-API boundaries.

## Layout

| Path | What |
|---|---|
| `src/index.ts` (`@mdbase-dev/sdk`) | The full entry: everything in the thin client, plus `MdbaseConnect` (which validates the app's declaration), people, timers, notifications, holds, `describeError`, `WasmRuntime` and `inProcessConnector` |
| `src/thin-client.ts` (`@mdbase-dev/sdk/thin-client`) | The thin client for consumers that bring their own connection (an Obsidian-plugin-style integration): codec, client, records, files, presence, Noise and relay transports, keys, status, availability. Held to 64 KiB gzip and never bundles manifest validation |
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

## Value model

Every client method answers in plain JSON. A record's `frontmatter`,
`effective` and `values`, a contract's `fields`, a description's `definition`
and `schema`, presence `state` and a conflict's values are `JsonValue`; a data
map is an object. A record goes through `JSON.stringify`, `structuredClone`,
`postMessage` and a store as it is.

```ts
const record = await db.get(id);
record.frontmatter.title;                        // JsonValue
const w = await db.update(record, { patch: { status: "done" } });
(await w.confirmed).records?.[0]?.frontmatter;   // the same shape
```

Reading YAML as JSON gives up three things:

| In the file | Read as |
|---|---|
| `1.0` (a float with no fraction) | `1` |
| an integer beyond ±(2^53−1) | a decimal string |
| a map whose keys look like integers (`2024:`) | an object that lists those keys first |

None of them is written back by accident. `update(record, { patch })` drops a
patched key whose value equals what the record held, so sending a record's own
frontmatter back changes nothing, and the replica compares the values a write
was based on by value (`1` is `1.0`, key order is free). The one case it cannot
match is an integer beyond 2^53 that the app replaces: its `base` is the string
that was read, so the replica treats the field as changed elsewhere.

Writes take plain data, and the exact forms where an app wants them: `Float64`
to write `1.0`, `bigint` for a large integer, a `Map` to fix key order
(`toValue` converts, `toPlain` converts back).

For the exact form of an answer, call without a codec and decode with a
`wire` codec. Nothing is rounded or reordered on that path:

```ts
import { wire } from "@mdbase-dev/sdk";

const answer = await db.call("query", new Map([[0, new Map([["types", ["task"]]])]]), { retry: true });
const [exact] = wire.queryResult.dec(answer).records;
exact.frontmatter;   // Map<string, CborValue>, in file order, with Float64 and bigint
```

| CBOR | Plain (client methods) | Exact (`wire` codecs) |
|---|---|---|
| integer within ±(2^53−1) | `number` | `number` |
| integer beyond that | decimal `string` | `bigint` |
| float with a fractional part | `number` | `number` |
| integral float (`1.0`, `-0.0`) | `number` | `Float64` (so `1` and `1.0` stay distinct) |
| data map (text keys, order is data) | object | `Map<string, …>` |
| struct map | named-field object | named-field object (`Map<number, …>` when raw) |

The root exports the plain types (`RecordView`, `Receipt`, `QueryResult`,
`DescribeResult`, …); `wire.RecordView` and the rest are the exact ones, and
`Plain<T>` maps one to the other. Numbers that are part of an answer's
structure, such as a file's size, and byte strings such as a blob ID are the
same in both. The `details` of a problem, issue or incident are plain JSON
everywhere, including on `MdbaseError`.

In both forms UUIDs are canonical lowercase strings, hashes are `sha256:<hex>`
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

## Settling a write

`settle` answers "was it saved, and how does the record read now?" in one call.
Pass it the write, the promise of one, or a mutation ID:

```ts
const saved = await db.settle(db.update(rec, { patch: { status: "done" } }), { read: { include: { body: true } } });
switch (saved.outcome) {
  case "confirmed":       // the sync service has it
  case "saved_on_device": // kept here; it syncs when the service can be reached
    render(saved.record);
    break;
  case "conflicted":      // confirmed, but a concurrent change won for some values
    render(saved.record); review(saved.conflicts);
    break;
  case "rejected":        // not saved
    show(describeError(saved.problem));
    break;
  case "unknown":         // it may have been saved
    remember(saved.mutationId);
}
```

| Outcome | Meaning | What to do |
|---|---|---|
| `confirmed` | The sync service has the write | Show `record` |
| `saved_on_device` | Still waiting after `timeoutMs` (default 3 s); the write is kept on this device | Show `record`; `db.ledger` reports how it ends |
| `conflicted` | Confirmed, but `conflicts` lists values this write lost to a concurrent change | Show `record`, and the conflicts if they matter to the person |
| `rejected` | Not saved. No `receipt`: the replica refused it when submitted. No `mutationId`: it was refused before anything was sent | Show `problem` |
| `unknown` | The result could not be read (a lost reply, or the read-back failed) | Keep `mutationId`; call `settle(mutationId, options)` again later |

`settle` never submits anything, so calling it again for an `unknown` write is
always safe; submitting the write again is not. It rejects only when the caller
aborts (`cancelled`), when it cannot tell which record to read back
(`invalid_request`: pass `read.record`), and for a failure that is not a write's
outcome. With `read`, `record` is the record as it now reads here, or `null`
when it no longer exists; `read.contract` adds `contractRecord`. `record.state`
says whether what you read is held or has unresolved conflicts
(`isProtected(record)`).
Likewise, `files.upload()` returns `FileWrite.fileId`; concurrent uploads on one
client run in FIFO order through the replica's single upload lane. An upload
releases the queue after its commit receipt, without waiting for log confirmation.

## Record sets

`db.recordSet({ types?, include?, signal? })` is every record of the chosen
types (default: all of them), read completely once and then kept current. It is
the set an app lists, searches and renders from.

```ts
const notes = db.recordSet({ include: { effective: true } });
const stop = notes.subscribe((changes) => {
  const { records, state, problem } = notes.getSnapshot();   // same object until something changes
  for (const c of changes) {
    if (c.kind === "remove") closeTab(c.previous.id);
    else if (c.previous && c.previous.path !== c.record.path) renameTab(c.record);
  }
  render(records, state);
});
await notes.ready;        // first complete read; rejects if it fails for good
notes.get(id);            // one record of the set
notes.close();
```

| `state` | `records` | What the set is doing |
|---|---|---|
| `loading` | what has arrived so far | The first complete read, one page at a time. |
| `current` | complete | Following the change feed. |
| `stale` | the last complete read | Reconnecting, rereading, or retrying. It recovers by itself; `problem` says what it is waiting on. |
| `failed` | kept | It cannot continue (`problem`, for example access removed). `reload()` tries again. |
| `closed` | kept | |

The set reads in pages, so a collection of any size fits. After that it rereads
only the records the change feed names, and resumes the feed where it left off
after a dropped connection. It reads everything again only when the feed cannot
say what changed, when a great many records changed at once, or on `reload()`.
Every listener call says which records were put or removed, a rename being a
put whose `previous.path` differs.

The change feed reports record changes. It does not report a changed type
definition, so call `reload()` after one if you show `effective` values or
`types`.

`db.live(query)` is a different tool: one window of at most 1,000 records and
1 MiB, ordered and counted by the replica. Use it for "the 50 tasks due next",
not for a whole collection.

## Record editor leases

```ts
const lease = await db.records.open({path: "notes/writing.md"}, {
  autosave: {idleMs: 500}, // omitted/false means explicit flush only
  signal,
});
const stop = lease.session.subscribe(() => render(lease.session.getSnapshot()));
lease.session.setBody(editedBody);
lease.session.patchFrontmatter({title: "New title"}); // undefined unsets a key
const result = await lease.session.flush({timeoutMs: 30_000, signal});
if (!result.ok) showProblem(result.problem);
stop();
lease.release();
```

UUIDs and `{path}` selectors use ordinary native `get`/`update` operations. Full
native document/body/revision and current protection gates are required; edits
use the actual source's whole-document CAS, field observations and body base.
There is no source reconstruction, replacement record UUID or new app database.
`records.open` throws SDK errors; `flush` returns `{ok, record}` or `{ok, problem}`.
Snapshots hold the plain `frontmatter` with unsaved changes applied, native `record`/`remote`, draft `body`,
`dirty`, `problem`, and the original `recovery` mutation identity/receipt/`Write`.
Saved requires actual confirmed, unprotected, same-UUID full native readback;
receipt confirmation alone (or optimistic/pending readback) is insufficient.

Submission is serialized per UUID/client. A mutation ID is exposed through the
snapshot **before** submission. Ambiguous submit/readback failures keep that ID;
subsequent flush only awaits its actual receipt, never resubmits or substitutes
another mutation. New edits made during capture remain drafts for a subsequent
intent only after the first has genuinely settled. A unique pending operation
from this client's native pending API can recover an editor session; foreign or
ambiguous pending ownership refuses. Across client lifetime/reload, retain the
snapshot's `RecordRecoveryRef` (`mutationId`, `recordId`, `baseRevision`) in the
caller-owned recovery state and pass it as `open(..., {recovery})`, particularly
when the receipt settled but readback failed. The helper adds no durable journal
and does not infer ownership from a shared current pending record.

Active leases share the UUID's draft/session and must agree on autosave/timeout
policy. Releasing/aborting one lease unsubscribes it without closing the client
or evicting another lease. Last release stops autosave/observation and aborts
late delivery, retaining unsaved/recovering data for reopen on the same client.
Client close suspends all leases. Retention is bounded to 64 sessions and 8 MiB
of serialized retained-data accounting; budget refusal never evicts drafts.
This accounting is not a measured peak-heap claim.

For a settled CAS conflict, `resolve({keep: "mine" | "theirs"})` or
`resolve({body})` explicitly rebases on a genuine confirmed/unprotected remote
readback. Native held/unresolved records remain refused: the current native
hold-resolution producer lacks caller-captured mutation identity and cancellation,
so this helper cannot safely resolve a hold or retry its unknown outcome. It does
not use a fresh `resolveHold` call as a workaround. Change notifications hydrate
the same UUID; observer failure is exposed, not treated as a successful refresh.

### Writer lease mapping

Writer's editor leases are local references to a shared draft/session, not
server-issued exclusive editing locks. Its existing lease contract maps to the
public SDK without a new lease RPC:

| Writer use | Public SDK operation |
| --- | --- |
| Open/follow a manuscript or embedded record | `records.open(ref, {autosave, timeoutMs, signal})`, session `subscribe` / `getSnapshot` |
| Edit body or staged frontmatter | Session `setBody` / `patchFrontmatter` |
| Autosave or explicit bounded save | Session `flush`; actual revision CAS and original mutation/receipt recovery |
| Show saved/conflict/recovery/deleted state | Genuine session snapshot; confirmed receipt plus full confirmed/unprotected same-UUID readback for saved |
| Choose a settled CAS conflict result | Session `resolve`; native held/unresolved records remain refused |
| Recover across client lifetimes (caller retains witness) | Retained `RecordRecoveryRef` passed to `records.open`; never a replacement mutation |
| Close an editor | Unsubscribe and `lease.release`; local lifetime release, not a remote unlock or save acknowledgment |

Sharing is per UUID/client, not across devices or independent clients. Revision
CAS protects save attempts; it does not exclude another editor. Writer's lease
flow does not need presence. The current native Replica presence RPCs return
`not_yet("presence")`, even though its hello can admit the `presence` marker;
negotiation alone is not a live presence implementation or write authority.
This mapping does not qualify Writer's native UI/runtime integration.

## Classic-script browser bundle

`npm run build` includes `dist/browser/mdbase-sdk.js` and
`dist/browser/mdbase-sdk.min.js` in the SDK archive. Serve the exact qualified
archive's asset from your app's origin; no CDN publication is implied.

```html
<script src="./vendor/mdbase-sdk.min.js"></script>
<script>
  const { connect, Client, AppHost } = window.MdbaseSDK;
  // Root exports match @mdbase-dev/sdk; Client groups client.ts exports.
  // AppHost matches @mdbase-dev/sdk/app-host.
</script>
```

Module consumers can import the same surface from `@mdbase-dev/sdk/browser`.
There is no `MdbaseConnect` compatibility shim or app-specific adapter. Loading
this bundle does not create a session, open storage, load a WASM runtime or grant
access. App-host APIs still require explicit qualified app/environment trust,
runtime, origin and custody inputs. This package does not supply a complete web
Worker/session/runtime composition; use the shared SDK composition when available,
not an app-specific substitute. Packaging tests are not sign-in, CRUD, custody,
physical durability or release-qualification evidence.

## Application access and step-up

`MdbaseConnect` replaces the Connect session's `authorize(target)`:
`authorize()` (sign in or choose), `reauthorize()` (the open or requested
collection, `authorize("selected")`), `approve(id)` (`{collectionId}`) and
`chooseAnother()`. Call them from the user gesture; the SDK reserves the popup,
and a `signal` replaces `timeoutMs`. There is no per-call capability list
(`requestCapabilities`, `requestOperations`, `ensure*`): approval always asks for
the declaration's groups.

`effectiveCapabilities(declaration, connection)` compares the declaration's v2
required and optional groups with the current session's negotiated hello grant,
for step-up UI only, and returns `{values, requiredAvailable, missing}` (null
without a v2 contract). It does not refresh permissions or authorize an
operation; native operation checks remain authoritative. For write access after
a read-only grant, show `missing` and call `reauthorize()`. Reauthorization still
requires user approval and may return another restricted grant.

### Optional file actions at the moment of use

Declare a file action the app needs only sometimes (adding an image, say) in
`requirements.files.optional`, and ask for it the first time the person does
that, from the same click:

```ts
const result = await app.requestAccess({files: ["add"]}, {reason: "Insert images into your notes"});
if (result.status === "granted") await connection.files.upload(path, image);
else if (result.status === "declined") show(describeError("access_declined"));
// "cancelled": the window was closed, the request expired or `signal` aborted.
```

`requestAccess` resolves `granted` at once, with no window, when the action is
already allowed (required, or allowed earlier). Otherwise it opens Connect for
the open collection with the one-line `reason` (at most 140 characters). The
connection stays open and the app keeps its state. An action the manifest does
not declare rejects with `access_undeclared`. Until the person allows it,
`files.upload` (and `replace`, `move`, `delete` when optional) rejects with a
`forbidden` error whose reason is `access_required`; its `describeError` copy
has an "Allow" action that should call `requestAccess`. `files.grant` leaves out
writes not yet allowed.

File-action consent is advisory on an installation device: Connect records the
person's choice and the SDK enforces it, but the app's own replica is not
narrowed by it.

## Cloud-copy first-open waits

Initial opening keeps the same enrolled device, native host, SQL and keys while
retrying a parsed CP HTTP 503 `busy` log-token refusal. There are at most three
log-init attempts; retries must fit a 15-second scheduling window and respect
Retry-After. Individual challenge/mint requests retain their 15-second deadlines.
Unknown 401/403/409 responses, malformed responses and generic unavailable errors
do not authorize a retry. Each failed mint retry obtains a fresh challenge/proof,
not another enrollment or collection.

For a previously synced local replica, the native verified-read gate keeps its
15-second deadline, including connect, pump and Query. For a cold replica (the
SDK join ledger has never recorded a completed first sync), the same 15 seconds
bounds **lack of progress**, not total catch-up time. The watchdog observes native
accepted prefix, advancing data/control READ cursors and snapshot-install
positions even while a multi-RPC pump is pending. Control READ cursors cover
key scanning whose native `reading` incident does not expose intermediate
positions. Only native-accepted replies to increasing cursors count; sending
calls, rejected replies, head growth, heartbeats and repeated cursors do not
reset it. Active, size/range-capped response bytes can defer a stall for the
already in-flight calls under their existing per-request deadlines; they do not
reset native progress or admit READ. Once those calls settle, successive retries
cannot renew that deferral without accepted native progress. This also covers
object downloads whose existing per-request budget exceeds 15 seconds.
Cold catch-up must reach the complete known prefix,
then pass an actual native Query; metadata never admits a data facade. A stall
fails typed `AppCloudCopyHostError("sync_stalled")` (the existing public
`unavailable` problem with a distinct diagnostic code).

Both paths retain typed READ-unavailable pacing (250 ms, 500 ms, then at most
one per second). Explicit server authority outcomes and typed HTTP 403
`forbidden` are latched against concurrent success. An HTTP status alone is not
terminal: stale-token 401 can invalidate/refresh through the existing authority,
and opaque routing/timeouts keep the existing NoResponse path. Native Query
`unauthenticated`/`forbidden` errors still refuse without retry. Cancellation stops the waits;
failed keyring recovery and non-retryable native errors still refuse. This remains the existing opening
state, with explicit retry after a terminal failure: no new migration state,
write/setup replay, legacy fallback or application retry loop is needed.

## Reopening a cloud copy from this device

A cloud copy whose join ledger records a completed first sync opens from the
replica on this device before the log is reached. The log-token request starts
in the background, a verified read is answered by the replica as it stands, and
the collection is handed to the app. The first drive turn then binds the log,
sends edits captured meanwhile and brings in what changed elsewhere. What the
app shows first is therefore the collection as of this device's last sync, and
it updates when the first turn lands. Saved views read in that window as well:
the replica serves them while it re-derives its keys from the log.

The ledger and the replica are stored separately. A replica that holds nothing
from the log (`holdsLog()` is false: its storage was lost after that sync) is
not opened this way. It binds the log first and catches up like a first open.

A bind that fails is sorted once:

- offline, unreachable, 5xx and 429 leave the collection open with `health`
  set, and the drive loop retries with its usual backoff and on foreground. A
  reply that is not Connect's, such as the sign-in page of a network the device
  has just joined, counts as unreachable;
- a server outcome with its own copy (migrating, suspended, update required,
  not yet migrated) shows as the connection's `problem` and is retried slowly;
- any other answer from Connect (401/403, other 4xx) sets the connection's
  `failure`. The sign-in session then blocks the collection with the same
  problem a failed open reports and closes it. It reads `failure` when the open
  returns as well as on later changes, so a refusal that arrived before the
  handoff never shows as ready.

Once bound, the replica checks its stored policy against the log while it
re-derives its keys. A replica that fails that check sets `failure` with
`recovery_required`, which is what a waited open refuses it with.

An edit made before the bind is an offline edit and is treated as one: kept
pending and sent once the log is bound. Nothing here changes what the log does
with an edit from a device whose access was removed while the app was closed.
A log token is valid for up to 16 minutes, so such a device can still bind
with a token it kept; refusing its entries is the log's job, as it was before.

The local read has five seconds. If the replica cannot answer it, the open
takes the ordinary path above. Private collections and cold replicas always
take that path.

A signed-in start likewise publishes the collection list this installation kept
from its last listing, with no request. That list carries no file actions and a
collection missing from it is not treated as removed. The Worker host then reads
Connect's list: straight after a start that already holds a collection,
otherwise after the page's next request, or after two seconds. A read that did
not happen (the session was busy, or the request failed) is tried again two
seconds later, three times in all; after that the next show or reconnect reads
it. `collectionListCached()` on the session says which list is showing.

## Private collections from web apps

`@mdbase-dev/sdk/app-grant` lets a signed-in web app open a Private collection
through the relay to one of the account's online computers. It is a separate
entry so apps that only use cloud copies don't load it.

- `new MdbaseAppGrants({declaration, redirectUri})`; `authorize({popup})` from the
  user gesture asks for a grant (OAuth PKCE, popup, at most 30 minutes). The
  redirect page calls `deliverAppGrantCallback(location.href)`.
- `collections()` lists granted Private collections with `availability`;
  `mergeCollectionEntries(cloud, privates)` merges them with cloud copies.
- `waitForAvailable(id, {timeoutMs})` polls (default 60 s, at most 10 minutes)
  and returns the last availability; it never waits on `sync_required` or
  `access_removed`. `connector(id)` opens; an unavailable collection fails with
  `collectionUnavailableError(reason)`, and `describeError` gives the copy.

Storage: the installation signing key and each grant's Noise static key are
non-extractable WebCrypto keys structured-cloned into IndexedDB. The refresh
token is stored only as AES-256-GCM ciphertext under a per-grant
non-extractable key, and access tokens stay in memory. Script can use but not
read these secrets, so it cannot copy them elsewhere; same-origin script running
while the app is open can still use them, so apps still need a strict CSP.
The default store belongs to the app's own manifest family (`bundle:<manifest
id>` from its declaration), never the id Connect assigns: the database name,
every record and the refresh ciphertext carry it, and records for another owner
are refused. Grants stored before this labelling are not adopted; the app asks
for access again and the old records are left in place.

### Listing and opening Private collections in an app

Every launch app follows the same pattern (the Editor's `private-collections.ts`
and `SdkEditorRoot.tsx` are the reference):

1. **Load it lazily.** Construct one `MdbaseAppGrants` per app, behind
   `import("@mdbase-dev/sdk/app-grant")` on first use, so the relay and grant code
   stay out of the initial bundle. `redirectUri` is the manifest redirect URI on
   the app's own origin.
2. **Handle the callback page.** When the app loads with `state` and `code` or
   `error` in its URL, call `deliverAppGrantCallback(location.href)`, then
   `window.close()`. Don't start the application SDK in that window.
3. **List.** Once signed in, merge `grants.collections()` into the chooser with
   `mergeCollectionEntries(snapshot.collections, privates)`. `collections()` is
   empty until this browser holds a grant, so always offer **Add a Private
   collection**. It calls `authorize({popup})`; reserve the popup with
   `window.open` inside the click, before any `await`.
4. **Show availability.** Every merged entry has one `availability` shape:
   cloud copies take theirs from `snapshot.collections` (absent there means
   available), Private ones from `collections()`.
   `describeError(entry.availability)` gives the title and message for each
   reason. Actions:

   | Availability | Action |
   |---|---|
   | `available` | Open |
   | `opening`, `device_offline`, `approval_required`, `desktop_update_required`, `old_connector_running`, `no_device_registered` | Open: `waitForAvailable(id, {onAvailability})` (bounded), then open when it reports `available` |
   | `sync_required` | **Give access again**: `authorize({popup, collection: id})` |
   | `access_removed` | No open. For a Private entry, offer `forget(id)` to remove it from this browser |
   | `collection_migrating` | Wait; the collection reopens when the upgrade is done |
   | `collection_deleted` | No open |

5. **Open.** `connect({connector: grants.connector(id), app})` returns an
   `MdbaseClient` that the app owns. Check `client.collection === id`, and close
   the client when the person leaves the collection. A failure carries its
   availability reason, so pass it to `describeError`.

6. **People.** `grants.people(id, client)` returns the same `MdbasePeopleClient`
   as cloud copies (`current()`, `members()`, `directory()`), reading Person
   records over `client` and identity and members from Connect with the grant.
   Until a computer approves the app, identity and members fail with
   availability `approval_required`; members also need the person's people
   approval (`people_permission_declined` otherwise). Needs a Connect server
   that serves people metadata for Private grants; older ones answer
   `people_unsupported` or refuse the token.

7. **Setup.** `grants.setup(client)` gives the same plan and review wording as
   a cloud copy's `setup`. `assess()` answers `ready`, `setup_required` or
   `incompatible`. `plan({adopt?, records?})` returns an `MdbaseSetupPlan`:
   show its `summary`, then each `changes[].message` (for example "Add the
   "task" record type."), and offer `adoptable` conflicts as a choice.
   `apply(plan)` writes everything in one guarded mutation that the person's
   computer checks. If anything changed since the review it refuses
   `setup_changed` and writes nothing, so plan again. The original Native session
   must negotiate `declared-collection-setup-v1`; Native verifies the signed
   declaration and plans the complete batch. This does not require or grant
   arbitrary `definitions.manage`. Starter notes independently need `records.create`.
   Before apply, the SDK durably retains an encrypted original mutation ID under
   existing grant custody. Lost/unknown outcomes reconcile that receipt only;
   they never replay setup or fall back to Hosted. Custom grant stores must
   implement the optional setup-attempt register to support setup.

Not covered yet for Private collections:

- The `MdbaseApplication` readiness flow (`configure`) doesn't apply; use
  `grants.setup(client)` and `grants.availability(id)`.
- Merged entries carry `role` (`owner`, `editor`, `viewer` or `null`). Cloud
  copies always have one. A Private entry's is `null` when Connect doesn't
  report it: older servers, or an account whose access needs renewing. Gate
  owner actions on `role === "owner"`; Connect still checks each action.

## Private collections on the app's own replica

An app that hosts its own replica through `MdbaseApplication` (`createMdbase`)
can open an existing Private collection with that replica, as a device of the
collection, instead of through the relay. The person unlocks it once with the
account's encryption password or recovery key. Connect only offers this to
apps it allows to hold a Private key.

- **Ask for it.** List `offline.replica` in the declaration's capabilities,
  under `requirements.capabilities.optional` or `required`. Prefer `optional`:
  the app then still signs in and syncs cloud copies where device access is not
  offered, and consent for an app grant on a current account refuses an app
  that lists it as required. The sign-in request asks for device access
  (`requested_private_device`), and the person chooses which Private
  collections to share. A server that does not know the request is asked again
  without it, and one that does not offer device access to this app answers
  with no Private collections; both leave an ordinary cloud-copy sign-in. An
  installation paired before this needs to ask for access again.
- **List.** Entries in `snapshot.collections` carry `mode: "private"`; absent
  means a cloud copy. A server from before this feature (after a rollback)
  answers the list without modes; the SDK then asks once more with the earlier
  request, so file actions are kept and no Private entry is listed.
- **Open.** `select(id)` as usual. An approval that shares only Private
  collections names no selected collection, so the app arrives in its chooser;
  when exactly one collection is approved the application opens it by itself,
  as it does a sole cloud copy. A device that already holds the key goes
  straight to `ready`. One that doesn't reads
  `{kind: "needs_unlock", collectionId, displayName, mode, unlocking, problem}`.
  There is no `connection` while locked.
- **Unlock.** For `mode: "password"`, call
  `mdbase.unlock(collectionId, {password})` or `{recoveryKey}` with what the
  person typed, and keep no copy. It resolves when the attempt has settled: the
  collection continues to `ready` (or `needs_setup`) without a reload, or the
  phase is still `needs_unlock` with `problem` set. `problem` is an
  `MdbaseProblem` with its copy already described; its `key` is one of
  `wrong_secret`, `invalid_recovery_key`, `rate_limited`, `unavailable`,
  `unlock_unavailable` or `unlock_failed`. `mode: "strict"`
  and `mode: "none"` cannot be unlocked here: explain that this collection has
  to be opened on a computer running the mdbase app.
- **Retries.** Connect limits how often an account's sealed key can be fetched
  (10 an hour, shared by all of the account's devices; `rate_limited` carries
  the wait). A mistyped recovery key (`invalid_recovery_key`) and a password
  shorter than the 12-character minimum (`wrong_secret`) are refused in the
  Worker without any request. After a wrong secret the Worker keeps the sealed
  bundle in memory for the next attempt on the same locked collection, and
  uses it only while Connect's status still reports the same account key
  version; it is dropped when the collection unlocks or closes.
- **Afterwards.** Once the unlock has applied, reopening needs no secret. A
  restart before it applied returns to `needs_unlock`.

The password or recovery key is sent to the Worker as bytes that are wiped in
the tab as soon as they are posted and in the Worker when the call settles. The
key it unlocks is used once and wiped; neither is stored. One installation can
be a device of one Private collection (`private_device_limit` for a second),
and People is not available for these collections yet: `connection.people`
is present, and its reads reject with `upgrade_required`
(`people_unsupported`).

To fetch the sealed account key, the app runtime signs one fixed request: the
account-key fetch proof for its own connector and device, over the server's
challenge and the signed-in account. It signs nothing else for the account key
(no change, no strict approval, no caller-chosen digest), and the fetched
bundle is still sealed under the person's password or recovery key, which both
kinds of unlock need. An older app runtime without this signer answers
`unlock_unavailable`, and the collection stays `needs_unlock`.

## Managed application build environments

Application declarations support explicit `lab`, `staging` and `production`
environments. Each SDK artifact must be packaged with the completed authenticated
trust handoff for that exact environment; changing an app build variable cannot
retarget a LAB archive. Staging packaging pins Connect to
`https://connect-staging.mdbase.dev`, production to `https://connect.mdbase.dev`.
CP/log origins and release trust still come only from the verified build context;
missing, expired or crossed trust refuses without a fallback. Isolated `local`
builds remain separate and refuse all managed environments.

### Developing on localhost

In every managed environment the app's own `origin` may be a loopback HTTP
origin (`http://localhost:<port>`, `http://127.0.0.1:<port>` or
`http://[::1]:<port>`), so an app is developed against production with the
published package:

```ts
createMdbase({ id, name, origin: "http://localhost:5173", environment: "production", manifest: devManifest });
```

The manifest's `homepage` and `redirect_uris` use that same origin. Connect
registers it as its own application, apart from the one published at the HTTPS
origin: approvals and device storage belong to the exact origin and are not
shared between the two. The approval screen calls it "an app running on this
computer" and says its identity is unverified, as it does for a native app.
Connect's own origins (control plane, log) stay HTTPS outside LAB; no other
plain-HTTP app origin is accepted.

`vite dev` and `vite build` both work with Vite's default configuration: the
SDK's worker and WebAssembly files are served from `node_modules` in
development and emitted as assets in a build.

The app manifest must declare the installation origin under
`installation_origins.staging` for staging pairing, just as for other environments.
Packaging support alone is not an application deployment or acceptance receipt.

## Native shells and browser extensions

A Capacitor app declares its native origin (for example
`capacitor://app.tasknotes.dev`) as `origin`, and lists it in the manifest under
`installation_origins.<environment>.mobile`. Pairing then uses installation kind
`mobile`. `capacitor://` origins default to that kind; an Android shell served
from https sets `installationKind: "mobile"`. A Chrome extension uses its
`chrome-extension://<id>` origin under `installation_origins.<environment>.app-runtime`.
Firefox `moz-extension://` origins differ per profile and are not accepted by
Connect.

Where a popup is unavailable, pass a sign-in opener:

```ts
const connect = new MdbaseConnect(declaration, {
  signIn: {
    open: url => Browser.open({ url }),            // or chrome.tabs.create({ url })
    close: () => Browser.close(),
    returnUrl: "dev.tasknotes.app://auth/mdbase/callback", // optional; see below
  },
  followVisibility: true, // re-poll as soon as the app returns to the foreground
});
```

`returnUrl` must exactly equal one of the manifest's `redirect_uris`, or the
constructor throws `application_sign_in_opener`. That is either an https URL on
the homepage origin or, for a native app, a private-use scheme derived from the
manifest ID (RFC 8252), such as `dev.tasknotes.app://auth/mdbase/callback` for
ID `dev.tasknotes.app`. No prefix or wildcard matching. Connect applies the same
exact match before it returns the user there. The URL carries no credential:
sign-in still completes by the SDK's pairing poll.

The SDK still binds the URL to the environment's Connect origin. The pending
pairing request is persisted, so a context that closes during sign-in (an
extension popup) resumes it on the next `start()`. Run extension sign-in from a
side panel or tab page where possible. Without `followVisibility`, call
`application().setForeground(active)` from the shell's resume/pause events.

An extension's pages, offscreen document and service worker are bundled
separately. The `session` option puts them in one session with one Worker:
see [`docs/sdk-shared-session.md`](../../../docs/sdk-shared-session.md).

### Running inside another app's document

A host app that runs the SDK in a document without a URL of its own (a `blob:`
iframe inside a mobile WebView, for example) passes two options:

```ts
const workerScript = await (await fetch(sdkWorkerUrl)).text(); // the SDK's own worker.js
const workerBlob = URL.createObjectURL(new Blob([workerScript], { type: "text/javascript" }));
const mdbase = createMdbase(declaration, {
  urlSelection: false,                                        // select with select()/approve()
  worker: url => new Worker(workerBlob, { type: "module" }), // url: where worker.js is served
});
```

- `urlSelection: false`: the SDK never reads or writes the page URL. A link or
  Back/forward no longer selects a collection, and the app selects with
  `select`, `approve` and `clearSelection`. The last-used collection is still
  remembered on the device. Without it, a `blob:` document reports
  `application_selection_binding`.
- `worker`: the SDK calls it with the URL it would load its module Worker from
  (`worker.js` beside the SDK's entry module). Return a module Worker running
  that script's exact bytes. The Worker loads `runtime.wasm`, `sqlite3.wasm`
  and `sqlite3.js` from `../native/` beside that URL, so serve the SDK's
  `dist/application` and `dist/native` files there; their bytes are still
  checked against the SDK's pins. A factory that throws or returns no Worker
  fails with `application_worker_unavailable`.

Both default to the ordinary behaviour, and a bundler-built app needs neither.

## Multiple vaults on one origin

Give each vault a stable, distinct `storage.applicationNamespace` (different
from the application ID). The SDK scopes tab/Worker grouping, pre-account
sign-in locks, protected installations and Private grants to that namespace.
Each vault pairs independently and receives its own installation/device IDs;
the existing device-key stores and OPFS replica pools then remain separate.
Signing out erases only that namespace's installations, grants and replica data,
and evicts log tokens matching its CP/connector/device, including unlisted
collections. Other vaults stay signed in.

```ts
const vault = createMdbase({
  ...declaration,
  storage: { applicationNamespace: "obsidian-vault-<stable-vault-id>" },
});
```

Omitted join/setup database names derive from the namespace. If you override
`joinDatabaseName` or `setupDatabaseName`, keep those names distinct per vault
as well: sign-out deletes those explicitly assigned journals. Namespace changes
select fresh local storage; they do not migrate or adopt a previous installation
or grant. Previously used overrides must pair and authorize afresh after this
change. Keep the same namespace across reloads and builds.

The no-override path keeps its existing names, owners, Worker grouping and
legacy sign-in compatibility locks, including legacy whole-token-cache erasure.
A default sign-out also clears all other vaults' cached log tokens on the origin;
they re-mint them on next open.
Public verified-asset and manifest-registration caches remain shared. Namespaces
organize storage; they are not a security boundary against other JavaScript on
the same origin. Consent and grant verification remain authoritative.

## Definition errors

An error-level issue on a definition the app does not declare never affects
readiness. An issue without a path always makes the collection
`incompatible`. By default, an issue on one of the app's own declared types
also makes it `incompatible`. To keep the rest of the collection usable, pass
`readiness: {typeIssues: "degrade"}`. The collection then stays `ready`, and
each affected type is listed in `readiness.assessment.unavailableTypes`
(`{name, path, contract, problem}`). Treat that type as unavailable. Show
`describeError(entry).message` for it. An error on a declared contract's own
definition always blocks.

## Collection setup

`application.setup` sets up the open collection from the app's declaration
with one review screen. `plan(options)` changes no collection data: native Core plans the
declared types into the collection's configured definition folders (an
installed pack stays where it is) and the SDK words the result for a
first-run user. Show `summary`, then `changes[].message` as a list,
`conflicts[].message` and `refusal.message` as is. No message contains a code.

Before planning, `plan` first settles any earlier setup still in progress
(for example, records that an interrupted apply was confirmed or finally
rejected), so it can write the SDK's own local setup journal. It never
prepares, submits or retries a collection change.

```ts
let plan = await app.setup.plan({ records: [{ path: "Welcome.md", document: welcome }] });
if (Object.keys(plan.adoptable).length && userChoseAppVersions) {
  plan = await app.setup.plan({ adopt: plan.adoptable, records: [{ path: "Welcome.md", document: welcome }] });
}
if (plan.canApply) await app.setup.apply(plan);
```

`status` is `current` (nothing to do), `setup` or `conflict`. A conflict that
`adoptable` lists is an existing definition with different content, or a type
the app seeded that was edited in a way no published version can be combined
with: if the user chooses the app's version, plan again with `adopt` and that
definition is replaced over exactly the reviewed revision. `staged` holds the definition
documents setup would write, for a details view.

Starter `records` (at most 32, 256 KiB in total) are created once, in the
same mutation as the setup, and only if setup has something to do. A path
that is already occupied is listed with action `skip` and left alone.
Creating them needs `records.create`. After apply, each starter record is
checked by its identity, path and confirmation, not by its exact bytes: Core
may canonicalize frontmatter on create, and a later edit to that note does not
make setup fail.

`apply(plan)` takes a plan from `plan` unchanged and writes everything as one
guarded mutation, all or nothing. If the collection changed since review,
including a definition or starter path taken in the meantime, it refuses with
`conflict`/`setup_changed`, nothing is applied, and the next `plan` starts
afresh. If another Private setup plan only retired Native's review ticket,
the SDK re-plans once and continues only when the fresh assessment and file
impact match the original consent. Different changes return `setup_changed`
(`mdbase.setup.apply` returns `outcome: "changed"`); show a fresh plan and ask
for consent again. Lost or uncertain mutation outcomes are never retried.
Refusal codes: `setup_forbidden` (no `definitions.manage`),
`setup_conflict`, `setup_unresolved`, `installed_newer` (a newer app version
set it up; `setup_downgrade` is its former name) and `setup_records_forbidden`.
`setup_unresolved` means the collection still lacks what the app needs but
setup has nothing it may write: a type the app seeded was removed. The person
restores it in the collection; readiness re-checks and the next `plan` reflects it.

`configure()` is plan and apply in one step, for collections with nothing to
review. A conflict leaves the configuration facet `incompatible`; use
`setup.plan()` to show it.

## Deleting a collection

Owners can delete a collection for everyone with `application.deleteCollection(id, {confirmName})`.
Show it only when the collection's `role` in `snapshot.collections` is `"owner"`, and only after a
confirmation where the person types the collection's name. `confirmName` must equal the current name after trimming (`New collection` for an unnamed one);
the control plane checks ownership and the name, and refuses while an account upgrade is in progress.

Deletion revokes access on every device and app right away and cannot be undone. On success the
collection leaves `collections` (and closes if it was open). A refusal rejects with a
`collection_delete_*` code and changes nothing; pass the error to `describeError()` for the copy.
`collection_delete_outcome_unknown` means the reply was lost: refresh the collections before retrying.

## Type packs

`client.typePacks.plan(pack, options)` asks the replica's Core to plan a type
pack against the local collection and writes nothing. The plan has `status`
(`install`, `upgrade`, `downgrade`, `reconfigure`, `current`, `conflict`),
`canApply`, a `summary` of targets by action for a diff, per-target
`resources`, `conflicts` with display-ready messages, and `refusal` (`code`,
`message`) when it cannot be applied. Show `refusal.message` as is.

```ts
let plan = await client.typePacks.plan(pack, { installedBy: "app.example.notes" });
if (Object.keys(plan.adoptable).length) {
  // The user reviewed the existing types: let the pack manage them.
  plan = await client.typePacks.plan(pack, { installedBy: "app.example.notes", adopt: plan.adoptable });
}
if (plan.canApply) {
  const result = await client.typePacks.apply(plan);
  // "pending" is accepted locally; wait for the original mutation to confirm.
  if (result.outcome === "pending") await result.write!.confirmed;
}
```

`apply(plan)` re-plans against the reviewed `digest` and submits every write
as one mutation, so the collection gets all of it or none. Each write,
including the lock and every adopted unchanged target, is bound to the
revision the plan reviewed. If anything changed since review, apply refuses
with `conflict`/`concurrent_modification`; plan again. A pack that is already
current returns `{ outcome: "already_current" }` and writes nothing.
Otherwise the outcome is `applied` (confirmed) or `pending` (accepted; await
`write.confirmed`, which rejects with the original mutation's problem). A
mutation the replica rejects or cannot settle throws its problem with the
original `mutationId` and is never reported as applied. `dryRun` returns
`preview` and installs nothing. Upgrades
use the pack's seed baselines. An older version is refused
(`type_pack_downgrade`) unless `allowDowngrade` is set.

Refusal codes: `forbidden` (no `definitions.manage`, reported by `plan`),
`type_pack_conflict`, `type_pack_downgrade`, `invalid_type_pack`,
`type_pack_contract_setups_unsupported`, and from apply
`concurrent_modification`. Older replicas return
`upgrade_required`/`type_packs_unsupported`.

## Saved-view sources

`db.views.createSource({id, path, document, type?}, {mutationId, ...writeOptions})`
creates the exact caller-supplied source. Capture and retain the record UUID and
mutation UUID before submitting (the SDK exports `uuidv7`). No renderer, record
type, filename extension or YAML is inferred or rewritten.

`db.views.getSourceRecord(ref, {include?, signal?})` requests a complete native
record with its document included. `db.views.updateSource(seen, document,
{mutationId, ...writeOptions})` uses that genuine `RecordView`'s UUID, path, full
source and revision for whole-document CAS. Pending revisions are valid; held,
unresolved, metadata-only or inconsistent source witnesses refuse. A new edit
needs its own captured mutation UUID, not a replacement for an unknown outcome.

Both write helpers return the original SDK `Write`, force document-inclusive
readback, and preserve receipt IDs, confirmation and publication separately.
Neither performs an implicit refresh or prepares/resubmits on unknown outcomes.
The ordinary client transport's same-mutation retry policy is unchanged.

For **web app-host** saved-view discovery/execution/exact source reads, use
`listAppBasesViews`, `executeAppBases` and `readAppBasesViewSource`, with the types
from `@mdbase-dev/sdk/app-host`. Keep native UUID/SHA/original ordinal and actual
source options. The generic `views.list/execute/readSource` RPC surface is not an
app-host fallback; unavailable capabilities remain explicit refusals.

To read a whole saved view in pages, iterate `executeAppBasesPages(request,
{firstPageSize?, pageSize?, signal?})` (defaults 200 then 1000 rows; at most
65536). Each page is one independent windowed read with `page`, `offset`,
`loaded` and `complete`. Native reads have no cross-request cursor or snapshot,
so `changedSinceFirst` marks pages read after the collection revision or matched
row count changed; rows may then be skipped or repeated, and callers that need a
coherent set restart. A native refusal is yielded once and ends the iteration.

## Persisted-record validation

```ts
const seen = await db.get(id, { include: { document: true }, signal });
const [validation] = await db.validate({ refs: [seen], signal });
// validation.id/path/revision identify the actual document validated.
for (const issue of validation.issues) {
  console.log(issue.severity, issue.code, issue.location, issue.message);
}
```

`validate({ refs?, signal? })` returns typed `RecordValidation[]` with real
Core `ValidationIssue`s, including optional location/type name and diagnostic
tier. UUID/path selections validate current native records; a `RecordView`
selection also requires the result to match that captured view's revision.
Changed revisions refuse with `record_validation_stale`; the SDK never refreshes
a witness or turns missing/refused/malformed/partial results into `[]`.
Order and duplicate selections are preserved. The original signal fences both
dispatch and final delivery, including an empty batch. Ordinary SDK read transport
policy is unchanged; no validation-specific retry or fallback is added.

This validates persisted/current local-native documents (including pending
changes), **not an unsaved draft or permission to submit/CAS a write**. A returned
revision records the version examined, not a promise that it remains current
after delivery. No types/contracts are installed implicitly. Older producers
without this operation remain real refusals, not empty success.

Selection count is at most 1000; paths are nonempty and at most 4096 UTF-8 bytes.
Native validation bounds examined documents/read work and refuses oversized
results (1 MiB/4096 issues/65536 nodes/depth 32). Omitted refs request a bounded
whole-collection inventory (at most 1000 records); some cross-record uniqueness
checks require that inventory even for an explicit record. Over-bound work is
`too_large`, never partial diagnostics. These are read/serialization bounds, not
a native peak-heap/CPU, app-intake or UI acceptance certificate.

## Shared read helpers

```ts
const records = await db.readMany(refs, {
  include: { effective: true },
  signal,
  concurrency: 8,
});
for await (const page of db.queryPages(query, { include, signal })) {
  displayPage(page); // retains complete/asOf/diagnostics, not only records
}
```

`readMany(refs, { include?, signal?, concurrency? })` makes ordinary `get` calls and
returns genuine `RecordView` values in input order. Duplicate selections retain
separate calls and output slots. Up to 1000 selections are allowed; concurrency
is an integer 1..16 (default 8). Path selectors must be nonempty and at most
4096 UTF-8 bytes. UUIDs (including a supplied view's UUID), paths, Include and
concurrency are captured before the first await. A view's old path/revision is
not asserted current and a partial input is never promoted to a native witness.

Missing/refused/error reads fail the entire batch with the first observed error,
not omitted rows or partial success. Scheduling stops; already-started reads
settle before that error is delivered. The original signal fences dispatch and
final delivery, including late backend replies. There is no helper-level retry,
refresh, fallback, replacement identity or cancellation of the caller's signal;
the ordinary SDK `get` transport policy is unchanged. Request/in-flight bounds
are not a peak-heap or returned-byte budget. Use explicit Include and bounded
selections when hydrating bodies/documents. Multiple gets are **not a single
native snapshot**; callers still check identity/source-revision witnesses.

`queryPages(query, { include?, signal?, onReset? })` delegates **exactly** to `pages`
and returns the same whole-page iterator. No records are flattened and no reset
is added. Root exports `readMany(client, ...)`, `queryPages(client, ...)` and
`ReadManyOptions` are also available.

## Feature negotiation and operation mapping

Use the existing `connect({ features: [...] })` / `client.hello.features` surfaces.
Keep the exact factory-owned request list, not a later-mutated options array:

```ts
const requestedFeatures = Object.freeze(["presence"]);
const client = await connect({ connector, app, features: [...requestedFeatures], signal });
function negotiatedMarker(name: string) {
  // Access the current hello; session errors propagate, never become false.
  const granted = client.hello.features;
  if (!requestedFeatures.includes(name)) return "not_requested";
  return granted.includes(name) ? "negotiated" : "not_negotiated";
}
```

While the initial hello is pending, a requested marker is **requested / pending**,
not unsupported. A successful hello grants only the requested-supported
intersection, not a complete catalog. An absent *unrequested* marker is not
negative evidence. Failed negotiation, no current session, connection/refusal
errors or cancellation stay errors; do not substitute `false` or a stale hello
from another session. No new probe or feature-discovery RPC is needed.

The current native Replica source admits `presence`, bare `attachment-v1` codec
support, and qualified `attachment-v1.read` / `attachment-v1.materialize`
directions where that replica supports them. Bare codec support does not grant a
direction; this producer does not grant `attachment-v1.write`. This is a source
inventory, not deployed runtime/transport/app acceptance. A testing replica's
advertised markers are not a native capability certificate.

Legacy Connect labels are not native feature names or negotiation aliases:

| Legacy probe | Public SDK mapping | What it does **not** prove |
|---|---|---|
| `query-metadata-v1` (Reader and Writer discovery) | `query` / `queryPages` with canonical Core `select` and explicit Include; typed `QueryResult` / `RecordView.values`, columns and page metadata | No legacy `output: metadata` mode, metadata-only SQL/performance guarantee or native feature marker |
| `read-many-documents-v1` (Reader hydration) | `readMany(refs, { include, signal })`; ordinary bounded `get` calls | No native bulk opcode, transaction or same-snapshot / shared-`asOf` proof |
| `query-record-revisions-v1` (legacy performance fixtures, not a Reader/Writer product probe) | Genuine mandatory `RecordView.id`, `.path` and `.revision` | No confirmed save, currentness after delivery, full edit base or draft/CAS authorization |

Writer's legacy changed-path `readMany` call has no bulk-feature probe. The next
Reader/Writer adapters do not require legacy feature probes: use their public
SDK operations and preserve actual errors. These mappings do not add an
app-specific engine, legacy protocol fallback, automatic query reset or new
permissions.

For discovery without bodies/documents, use explicit `{ body: false, document:
false }` Include and the intended canonical query selection. Retain whole pages,
`complete`, `asOf`, diagnostics and opaque cursors; unsupported semantics or
insufficient native budgets refuse, not approximate or empty success. Discovery
and hydration can observe different cuts: recheck actual ID, provider/source and
revision witnesses rather than treating multiple gets as one snapshot.

`client.hello.grant.capabilities` and role are hello-time permission snapshots,
**not current authorization or feature support**. READ uses `collection.read`;
ordinary native RPC reauthorization remains authoritative. `describe()` inspects
catalog/types/contracts, not a feature catalog. Neither a successful grant nor a
negotiated marker overrides a later native refusal. Keep the original signal and
problem; do not turn errors into negative capabilities or fabricated diagnostics.

## People and canonical contract inspection

```ts
import { MdbasePeopleClient } from "@mdbase-dev/sdk";
// Inside the trusted owned Worker, after collection adoption and CP transport pinning.
// host is the existing AppWebCloudCopyHost; its session/credential stays private.
const metadata = host.peopleAuthority();
const people = new MdbasePeopleClient(db, metadata);
const directory = await people.directory({ members: "if-approved", signal });
directory.account; // public exact issuer/subject/name/account UUID
directory.me;      // linked, unlinked, ambiguous, or invalid; never name/email inference
directory.people;  // complete native mdbase.person 2.0.0 inventory
// host.close() retires metadata before native/SQL shutdown.
```

The host returns only a frozen read-only metadata view, not a session or bearer
getter. Send only public directory projections over the Worker channel. Other
trusted hosts owning a genuine registered-device session can construct
`AppCpPeopleAuthority` internally; callers must never reconstruct it from receipts.

`current()` and `members()` read fixed CP metadata endpoints; `directory()` uses
Core's canonical resolved mappings, defaults and validation through
`db.queryContract({ id, version }, { pageSize, cursor, signal })`. It does not
recreate contract semantics from raw frontmatter. The directory checks CP/native
collection binding and consumes every native continuation under one session,
`asOf` and contract digest; stale/incomplete/oversized inventories fail as a whole.
A full unindexed window refuses with `contract_query_cursor_required`, not a
fabricated cursor or partial result. A fresh absent registered Person contract
means unlinked; disappearance after any page is an error. Invalid claiming
records take precedence over an otherwise linked match. Optional members are
omitted only for explicit permission decline (or `members: "omit"`), never scope,
revocation, integrity or network errors. Old producers refuse the additive
version-one method, without an SDK projection fallback. No record path/payload
or key is sent to the metadata authority.

## Query cursor resets

`pages(query, { include?, signal?, onReset? })` repeats the original query with the
replica's opaque cursor. By default, typed `invalid_request/fix_request` reasons
`cursor_expired` and `cursor_stale` are thrown unchanged. There is no offset
fallback or automatic mixing of already-yielded pages with a fresh query.

To opt in to **one restart per iterator**, clear your accumulated/displayed
paging state in the awaited `onReset` callback:

```ts
for await (const page of db.pages(query, {
  include,
  signal,
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
npm ci && npm run typecheck && npm test && npm run build && npm run bundle-boundaries   # or: cargo xtask sdk
```

`npm run bundle-boundaries` fails when either entry bundles the Ajv compiler
(manifest validators are precompiled in connect-protocol), the thin client
bundles yaml, or either bundles `app-grant`.
