# `@mdbase-dev/connect`

Browser SDK for dynamically discovered mdbase connect applications.

It also ships a dependency-free browser bundle for downloaded HTML
applications. See the [portable application guide](../../docs/portable-apps.md)
for the v1 manifest, device-code flow, version-pinned CDN URL, SRI metadata,
and `file://` storage boundary.

Ordinary applications install only `@mdbase-dev/connect`. Add
`@mdbase-dev/connect-dev` for declaration/type-pack authoring,
`@mdbase-dev/connect-testing` for supported test fixtures,
`@mdbase-dev/connect-sync` for an offline mirror, or the Pickle package only
when the application uses that feature. Wire and authority implementations use
`@mdbase-dev/connect-protocol`; ordinary application code does not.

The complete developer guide covers
[setup](https://mdbase.dev/sdk/quickstart/),
[manifests and contracts](https://mdbase.dev/sdk/manifest/),
[authorization](https://mdbase.dev/sdk/authorization/),
[operations](https://mdbase.dev/sdk/operations/),
[routing](https://mdbase.dev/sdk/routing/),
[offline sync](https://mdbase.dev/sdk/offline-sync/), and
[testing](https://mdbase.dev/sdk/testing/).

```ts
const mdbase = new MdbaseConnect({
  serverUrl: "https://connect.mdbase.dev",
  manifest: new URL(".well-known/mdbase-app.json", location.href).href,
  redirectUri: "https://workouts.example/auth/mdbase/callback",
  timeouts: {
    requestMs: 15_000,
    watchStartMs: 20_000,
    uploadMs: 120_000,
    syncMs: 60_000
  }
});
const session = mdbase.application({
  selection: new MdbaseBrowserSelection()
});
const unsubscribeSession = session.subscribe(() => render(session.getSnapshot()));

const startup = new AbortController();
const started = await session.start({ signal: startup.signal, timeoutMs: 20_000 });
if (!started.ok) {
  renderProblem(started.problem);
  return;
}
if (session.getSnapshot().status === "unselected") {
  const authorized = await session.authorize("choose");
  if (!authorized.ok) {
    renderProblem(authorized.problem);
    return;
  }
}

const snapshot = session.getSnapshot();
if (snapshot.status !== "ready") throw new Error("Choose an authorized collection.");
const connection = session.connection();
if (!connection) throw new Error("The ready session has no active connection.");
const queried = await connection.query({ types: ["workout"] });
if (!queried.ok) {
  renderProblem(queried.problem);
  return;
}
const workouts = queried.value;
const current = await connection.read({ path: workouts.results[0].path });
if (!current.ok) {
  renderProblem(current.problem);
  return;
}
const updated = await connection.update({
  path: current.value.path,
  patch: { completed: true },
  ifRevision: current.value.revision
});
if (!updated.ok) renderProblem(updated.problem);

const pageLifetime = new AbortController();
const watch = await connection.watch(
  { lifetimeSignal: pageLifetime.signal },
  { timeoutMs: 20_000 }
);
if (!watch.ok) {
  renderProblem(watch.problem);
} else {
  const unsubscribeWatch = watch.value.subscribe(
    (change) => console.log(change.type, change.payload.path),
    renderWatchStatus,
    renderProblem
  );
  // On navigation: unsubscribeWatch(); watch.value.close();
}
```

Expected failures are returned as typed `ConnectOutcome` values. Exceptions are
reserved for programming errors and broken SDK invariants. See
[typed outcomes and recovery](../../docs/sdk-outcomes.md) for the complete
problem model, setup failures, mutation uncertainty, and UI guidance.

SDK call options, operation inputs, results, descriptors, and progress events
use camelCase. The client translates canonical snake_case protocol payloads at
the authority boundary. Versioned JSON documents such as `MdbaseAppManifest`
and `TypePackProvision`, problem detail objects, diagnostics, and user-owned
frontmatter retain the exact field names defined by their own schemas.

React applications can use the same session without introducing another state
owner:

```ts
const store = externalStore(session);

function useMdbaseSession() {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}
```

Browser and native callbacks share the same typed completion boundary:

```ts
const browserResult = await session.completeAuthorization(location.href, {
  timeoutMs: 15_000
});
const nativeResult = await session.completeAuthorization(deepLinkUrl, {
  signal: appForeground.signal,
  timeoutMs: 15_000
});
```

Unknown writes are recovered through their durable handles, never by calling
the original mutation again with reconstructed input:

```ts
for (const pending of connection.pendingMutations()) {
  showRecoveryAction(pending.requestId, async () => {
    const recovered = await pending.recover({ timeoutMs: 30_000 });
    if (!recovered.ok) renderProblem(recovered.problem);
  });
}
```

`MdbaseConnect` is the application-level authorization registry.
`MdbaseApplicationSession` is the normal application boundary: it owns active
collection selection, authorization completion, semantic capabilities,
definition compatibility, and one reactive snapshot. Applications declare
versioned capabilities in their manifest; they never maintain a parallel array
of protocol operations. Use `getSnapshot()` and `subscribe()` directly or
through your framework's external-store integration.

The session distinguishes `authorization_required`, `checking_setup`,
`setup_review_required`, `ready`, `unavailable`, and `blocked`. Setup
inspection is read-only. If an update is needed, render the supplied plan and
apply the exact assessment the user reviewed:

```ts
const snapshot = session.getSnapshot();
if (snapshot.status === "setup_review_required") {
  renderCollectionSetup(snapshot.update);
  const applied = await session.applyCollectionSetup({ timeoutMs: 30_000 });
  if (!applied.ok) renderProblem(applied.problem);
}
```

A `ready` snapshot may be `cached` for immediate startup and is then reverified
in the background. Route details remain diagnostics; feature UI should read
`snapshot.capabilities`, whose values explain whether a capability is available,
needs authorization/setup, is temporarily unavailable, or is unsupported by the
selected authority.

`MdbaseBrowserSelection` keeps the stable collection ID in
`?collection=<id>`, preserves unrelated path/query/hash and router state, and
reports browser back/forward
changes to the session. The session auto-selects only when exactly one saved
connection exists. Switching is state-driven and must not reload the page:

```ts
session.select(collectionId, { history: "replace" });
session.clearSelection();
session.forget(collectionId);
```

Selection validates the saved authorization before changing the URL. Explicit
unavailable IDs remain authoritative so applications can offer exact
reauthorization or another collection:

```ts
await session.authorize("selected"); // exact bookmarked collection
await session.authorize("choose");   // any compatible collection
await session.authorize({ collectionId }); // exact adoption/migration target
```

Collection IDs are opaque non-secret locators that may appear in browser
history and logs. Grants remain the authorization boundary, and names are
display text that may change.

The SDK keeps one non-extractable P-256 installation signing identity per
server/application and signs every authorization ceiling with it. Grant
agreement and signing keys remain disposable and are replaced on
reauthorization. For local collections, the SDK also pins the connector public
key after the first successful authorization and rejects silent replacement as
`connector_identity_changed`, even after the grant is forgotten. Only call
`forgetConnectorIdentity(connectorId)` after independently verifying an
intentional connector replacement.

Bundled v1 application manifests can declare runtime notification criteria.
Register a service worker from a user gesture to receive standards-based Web
Push while the app is closed:

```ts
const worker = await navigator.serviceWorker.register("/service-worker.js");
await connection.registerNotifications({
  serviceWorker: worker,
  criteria: ["workout.reminder"]
});
```

In the service worker:

```ts
import { showMdbasePushNotification } from "@mdbase-dev/connect";

self.addEventListener("push", (event) => {
  event.waitUntil(
    showMdbasePushNotification(self.registration, event.data?.json())
  );
});
```

Pushes contain an opaque signal and cursor plus static declaration presentation,
never record paths or content. Treat them as a wake-up hint and read current
authorized state after opening. Registration atomically replaces the selected
criteria for that installation. See the
[runtime notifications guide](../../docs/notifications.md) for declaration and
deployment examples.

Native shells can use one FCM token for Android and iOS when the declaration
declares `notifications.native_delivery.mode` as `managed_fcm`:

```ts
await connection.registerNativeNotifications({
  token: await nativeMessaging.getToken(),
  criteria: ["workout.reminder"]
});
```

Re-register when Firebase rotates the token. Parse the string-valued
notification data with `parseMdbaseNativeNotificationData()`, refresh current
collection state, and call `unregisterNativeNotifications()` before deleting
the token on opt-out. The public Firebase project ID is read from the
application declaration; service credentials are never embedded in the app.

Connect-managed FCM makes Connect a trusted sender for the application's
Firebase project. It suits single-owner deployments; applications with a
broader audience should normally declare signed webhook delivery and keep
their Apple/Firebase credentials in their own backend. The notifications guide
documents both threat models. New or changed declaration criteria never silently
broaden an existing grant: handle `notification_reauthorization_required` by
running authorization again before retrying registration.

Before opening a feature, inspect its exact authorization gap instead of
waiting for an operation to fail:

```ts
const required = ["read", "query", "update"] as const;
const capabilities = connection.authorizationCapabilities([...required]);
if (!capabilities.sufficient) {
  console.log("Needs", capabilities.missingOperations);
  await connection.requestOperations([...required]);
}
```

`requestOperations()` is a no-op when the current grant is sufficient. When a
replacement grant is needed, it requests the least-privilege union of the
already granted operations and the missing requirements. An
An `insufficient_access` problem carries the same `granted_operations`,
`missing_operations`, and `required_operations` metadata with a `reauthorize`
recovery action.

Applications that declare an `mdbase.runtime.timer.fired` notification criterion can keep
one-shot reminders at the collection authority:

```ts
await connection.reconcileTimers({
  namespace: "workout-reminders",
  criterionId: "workout.reminder",
  timers: [{
    id: "workout-42",
    fireAt: new Date("2026-07-25T10:00:00Z").toISOString()
  }]
});
```

The SDK also exposes `listTimers()`, `putTimer()`, and `cancelTimer()`.
Reconciliation is atomic and is normally the safest way to project a complete
desired timer set. IDs and optional timer data stay at the local connector or
hosted provider and are not included in notification signals.

When the local connector definitively rejects an encrypted grant, the SDK does
not bypass that decision through the relay. It classifies the error as requiring
authorization, removes only the matching stale credential, and emits a `null`
connection through `onConnectionChange()`. A subsequent
`requestOperations()` call therefore starts authorization instead of trusting
the stale cached capability list.

Applications with full collection access can also register and maintain type
definitions. Type source is returned with a revision token so updates cannot
silently overwrite a definition changed by another application:

```ts
const created = await connection.createType({
  document: `---
kind: mdbase.type
name: workout
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
`
});

if (!created.ok) return renderProblem(created.problem);
const current = await connection.readType({ name: "workout" });
if (!current.ok) return renderProblem(current.problem);
const updatedType = await connection.updateType({
  path: current.value.path,
  document: current.value.document.replace("version: 1", "version: 2"),
  ifRevision: current.value.revision
});
if (!updatedType.ok) renderProblem(updatedType.problem);
```

Request `read_type`, `create_type`, and `update_type` during authorization.
Contract-scoped applications cannot manage collection-wide type definitions.

To install a complete catalog pack without exposing its individual collection
paths, request `assess_type_pack` and `apply_type_pack`, fetch and verify the
published provision, then review and apply the authority's exact plan:

```ts
const response = await fetch(pack.provisionUrl);
const provision = await response.json();
const installedBy = "dev.example.catalog";
const assessment = await connection.assessTypePack({
  provision,
  installedBy
});
if (!assessment.ok) return renderProblem(assessment.problem);

renderDefinitionChanges(assessment.value);
const applied = await connection.applyTypePack({
  provision,
  installedBy,
  expectedAssessmentDigest: assessment.value.assessmentDigest
});
if (!applied.ok) return renderProblem(applied.problem);
```

The caller remains responsible for verifying the catalog digest before sending
the provision. Apply rechecks the reviewed assessment inside the transaction;
stale plans and locally modified targets fail without partial writes.

For a local collection, ask for same-computer access from a user gesture:

```ts
const status = await connection.checkDirectAccess();
if (!status.ok) return renderProblem(status.problem);
if (status.value === "permission_required") {
  directButton.onclick = () => connection.requestDirectAccess();
}

connection.onConnectionChange((info) => {
  console.log(info?.route); // "direct", "relay", or "remote"
});
```

After permission is granted, all grantable operations prefer the fixed
loopback connector automatically. If it is absent or unavailable, the SDK
retries the exact encrypted envelope through the relay. Durable connector
receipts prevent an ambiguous direct write from running twice. The SDK retains
one unresolved encrypted mutation locally and requires that exact write to be
retried before a later mutation can overtake it. Set
`directAccess: "disabled"` only when an embedding environment cannot use
loopback requests.

The SDK loads the v1 manifest from the application's own bundle and
posts it inline to Connect. Connect identifies the exact canonical declaration
by its digest. The declared reverse-domain ID and name are presentation
metadata, not proof of a publisher; grants remain bound to the authorization
completed by that installation. No developer account, public manifest host, or
manually issued client secret is required.

Applications declare exact data-contract versions in their bundled manifest.
Connect offers collections that already provide those contracts or can install
the declared type pack safely. The developer helper computes every resource
digest:

```ts
import { defineTypePack } from "@mdbase-dev/connect-dev";

const contract = `---
kind: mdbase.contract
contract_type: record
id: example.work-item
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    properties:
      title: { type: string }
---
`;
const type = `---
kind: mdbase.type
name: work-item
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
implements:
  - contract: example.work-item
    version: 1.0.0
    fields: { title: title }
---
`;

const workItemPack = defineTypePack({
  id: "example.work-items",
  version: "1.0.0",
  resources: [
    {
      kind: "contract",
      mode: "managed",
      source: "_contracts/example.work-item.md",
      document: contract
    },
    {
      kind: "type",
      mode: "seed",
      source: "_types/work-item.md",
      document: type
    }
  ]
});

export const manifest = {
  manifest_version: 1,
  id: "dev.mdbase.worklog",
  name: "Worklog",
  homepage: "https://worklog.example",
  redirect_uris: ["https://worklog.example/auth/mdbase/callback"],
  requirements: {
    contracts: workItemPack.provides
  },
  provisions: {
    type_packs: [workItemPack]
  }
};
```

Set `collection_kind` to `hosted` when the application needs a durable
provider-backed collection and the offline sync transport returned by
`sync()`. Connect then offers and accepts collections with replication capability.

Access defaults to the record types supplied by `requirements.contracts`.
Set `access` to `full_collection` when the application needs collection-level
features such as saved views. Required contracts still determine compatibility
and are provisioned during approval.

`listViews()` returns each named view's selected result properties in display
order. Property descriptors retain source labels for projected and computed
values. `executeView()` returns their values on each result row.

Provisioning is part of the approval flow. The connector validates and
installs each missing type pack transactionally, verifies its exact contracts
and implementations, and creates the scoped grant afterward. The application
is not granted collection-wide type-management access.

The SDK returns typed outcomes, carries successful mdbase diagnostics alongside
the value, carries revision tokens in typed record results, and accepts
`ifRevision` on mutations. `describe()` exposes
JSON Schemas, portable type definitions, canonical collection settings, and
first-class data contracts. `watch()` resumes from a local collection cursor;
the Connect server does not store the change feed.
`queryAll()` treats `timeoutMs` as one deadline for the complete paginated
query. The caller-driven `queryPages()` iterator instead accepts
`pageTimeoutMs`, an independent budget for each page, plus a lifetime `signal`.
`preflightRename()` and `preflightDelete()` run the canonical collection
operation without changing records or advancing the change cursor, so an app
can show authoritative reference impact before asking for confirmation.
`renameWithProgress()` and `deleteWithProgress()` expose preflight, ready,
applying, completed, and cancelled phases with an impact estimate. Cancellation
remains available during an encrypted local/relay mutation because the SDK
persists its exact encrypted request before dispatch. If waiting is cancelled
after dispatch, `pendingMutations()` exposes durable handles. A handle's
`recover()` method resends the exact stored request identity and bytes; callers
never reconstruct or resupply mutation input. Multiple interrupted writes are
independently recoverable. Other providers are cancellable until apply begins
and then run to a definitive response.
Authorization is retained in `localStorage` by default. Access tokens are
renewed with rotating refresh tokens; passing a custom `Storage` implementation
allows a host to choose another persistence boundary.

Native shells can pass `navigate` to open the approval URL in the system
browser and list a reverse-domain callback such as
`dev.mdbase.worklog://auth/mdbase/callback` in the bundled declaration. Its
scheme must match the declaration ID. `authorize()` returns `redirecting`; the
browser redirects to the declared callback with a short-lived code and state,
and the shell passes that URL to `completeAuthorization()`. PKCE prevents the
callback code from being exchanged without the pending application state and
verifier.

New authorizations require operation transport v3 and grant encryption profile
v1 by default. The SDK keeps independent non-extractable P-256 ECDH agreement
and ECDSA signing keys plus an atomic message counter in IndexedDB. It encrypts
operation inputs for the connector, decrypts connector results locally, and
signs hosted authority requests with the independent signing key. Set
`relayEncryption: "disabled"` only for development where end-to-end relay
encryption is intentionally unavailable; an encrypted grant never falls back
to plaintext.

For a hosted collection, the same authorization exchange returns a short-lived,
grant-bound provider capability. The SDK routes operations directly to the
hosted Rust data plane, binds browser requests to the approved callback origin, and does
not send record payloads through the Connect control plane. Refresh rotation,
permission narrowing, and revocation keep the same public SDK behavior across
local and hosted authorities.

`sync()` exposes a provider-neutral sync transport without exposing the
provider credential. It refreshes the grant-bound capability as needed and can
be passed directly to `@mdbase-dev/connect-sync` for an offline application cache.

Applications request non-Markdown files separately from record contracts:

```ts
requirements: {
  contracts: [],
  files: {
    actions: ["list", "read", "add", "replace", "move", "delete"],
    scope: { kind: "selected_folders", folders: ["Photos"] }
  }
}
```

The granted connection exposes one storage-neutral facade. Hosted uploads go
directly to private R2 objects through short-lived prepared requests. Downloads
use authenticated bounded ranges so the authority can recheck access between
parts. Object keys, multipart ETags, provider credentials, retries, and
integrity checks stay inside the SDK.

```ts
const saved = await connection.files.upload("Photos/image.jpg", browserFile, {
  onProgress: ({ phase, transferredBytes, totalBytes }) => {
    console.log(phase, transferredBytes, totalBytes);
  }
});

const large = await connection.files.uploadStream("Media/video.mp4", {
  size: manifest.size,
  contentDigest: manifest.sha256,
  stream: response.body!
});

for await (const file of connection.files.list({ folder: "Photos" })) {
  const stream = await connection.files.downloadStream(file);
  await stream.pipeTo(destination);
}

const moved = await connection.files.move(saved, "Archive/image.jpg");
await connection.files.delete(moved);
```

`download()` and `downloadBytes()` are convenient for values up to 64 MiB.
Use `downloadStream()` for larger files; it verifies the pinned revision while
forwarding response chunks with native stream backpressure rather than
buffering a complete hosted range.
The live stream retries unopened chunks and can switch a local download between
direct and relay. It does not persist progress after consumption stops or
resume a hosted range after part of that range has reached the consumer;
restart `downloadStream()` to reopen the pinned revision in those cases.

`upload()` accepts `Blob`, `ArrayBuffer`, and typed-array values and hashes them
before opening the transfer. `uploadStream()` accepts a `ReadableStream` or
async iterable plus its exact size and `sha256:…` commitment. It verifies the
stream while uploading sequentially without accumulating multiple file parts.
SDK memory is bounded by one assembled negotiated part plus at most one source
chunk; a single-part upload may therefore hold the complete file. Yielded
source chunks must fit within the authority's negotiated upload part; ordinary
browser and Node streams already produce much smaller chunks. After an
ambiguous failure, call it again with a newly opened source and the same
`transferId` to resume safely.

Both lifecycle methods are optimistic and use the descriptor revision by
default. Pass a stable `mutationId` when retrying after an ambiguous network
failure; the authority returns the original durable receipt instead of applying
the change twice.

Record-facing code can depend on `MdbaseCollectionClient` instead of the OAuth
client. It accepts a small `MdbaseCollectionTransport`, which is the stable seam
used by Connect, the developer sandbox, and future hosted providers. This keeps
application logic independent of authorization and deployment topology.
