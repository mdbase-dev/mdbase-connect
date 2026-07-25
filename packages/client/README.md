# `@mdbase/connect`

Browser SDK for dynamically discovered mdbase connect applications.

It also ships a dependency-free browser bundle for downloaded HTML
applications. See the [portable application guide](../../docs/portable-apps.md)
for the v1 manifest, device-code flow, version-pinned CDN URL, SRI metadata,
and `file://` storage boundary.

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
  redirectUri: "https://workouts.example/auth/mdbase/callback"
});

await mdbase.authorize({
  operations: ["describe", "changes", "read", "query", "update"],
  returnTo: location.pathname + location.search
});

// On the callback route:
const { connection, returnTo } =
  await mdbase.completeAuthorization(location.href);
const description = await connection.describe();
const workouts = await connection.query({ types: ["workout"] });
await connection.update({
  path: "workouts/monday.md",
  patch: { completed: true },
  if_revision: workouts.result.results[0].revision
});

const preview = await connection.preflightRename({
  from: "workouts/monday.md",
  to: "archive/monday.md",
  update_refs: true,
  if_revision: workouts.result.results[0].revision
});
console.log(preview.result.references_affected);

const controller = new AbortController();
await connection.renameWithProgress({
  from: "workouts/monday.md",
  to: "archive/monday.md",
  update_refs: true,
  if_revision: workouts.result.results[0].revision
}, {
  preflight: preview.result,
  signal: controller.signal,
  onProgress: ({ state, estimate, cancellable }) => {
    console.log(state, estimate?.affectedRecords, cancellable);
  }
});

for await (const change of connection.watch()) {
  console.log(change.type, change.payload.path);
}
```

`MdbaseConnect` is an application-level manager. It can retain several
independently authorized collections; call `connections()` to list them and
`connection(collectionId)` to obtain a client permanently bound to one. Pass
that `MdbaseConnection` into repositories and feature code.

For bookmarkable static applications, store the stable ID in a query parameter
such as `?collection=<id>`. Treat an explicit ID as authoritative and show the
chooser or reconnect that exact ID when it is unavailable. Collection names
are display text and may change.

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
import { showMdbasePushNotification } from "@mdbase/connect";

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
`insufficient_access` error carries the same `grantedOperations`,
`missingOperations`, and `requiredOperations` metadata with a `reauthorize`
recovery action.

Applications that declare a `timer.fired` notification criterion can keep
one-shot reminders at the collection authority:

```ts
await connection.reconcileTimers({
  namespace: "workout-reminders",
  criterion_id: "workout.reminder",
  timers: [{
    id: "workout-42",
    fire_at: new Date("2026-07-25T10:00:00Z").toISOString()
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

const current = await connection.readType({ name: "workout" });
await connection.updateType({
  path: current.result.path,
  document: current.result.document.replace("version: 1", "version: 2"),
  if_revision: current.result.revision
});
```

Request `read_type`, `create_type`, and `update_type` during authorization.
Contract-scoped applications cannot manage collection-wide type definitions.

For a local collection, ask for same-computer access from a user gesture:

```ts
const status = await connection.checkDirectAccess();
if (status === "permission_required") {
  directButton.onclick = () => connection.requestDirectAccess();
}

connection.onConnectionChange((info) => {
  console.log(info?.route); // "direct", "relay", or "hosted"
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

Applications declare required domain contracts in their bundled manifest. Connect only
offers collections that are compatible or can be configured safely, then derives
the record scope from this declaration. It may include portable
type definitions for the connector to install during approval:

```json
{
  "manifest_version": 1,
  "id": "dev.mdbase.tasknotes",
  "name": "TaskNotes",
  "homepage": "https://tasks.example",
  "redirect_uris": ["https://tasks.example/auth/mdbase/callback"],
  "requirements": {
    "collection_kind": "hosted",
    "access": "full_collection",
    "contracts": [{ "id": "tasknotes.task", "version": 1 }]
  },
  "provisions": {
    "types": [{
      "name": "Task",
      "document": "---\nkind: mdbase.type\nname: task\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\nx-tasknotes:\n  contract: tasknotes.task\n  version: 1\n---\n",
      "provides": [{ "id": "tasknotes.task", "version": 1 }]
    }]
  }
}
```

Set `collection_kind` to `hosted` when the application needs a durable
provider-backed collection and the offline sync transport returned by
`hostedSync()`. Connect then offers and accepts hosted collections only.

Access defaults to the record types supplied by `requirements.contracts`.
Set `access` to `full_collection` when the application needs collection-level
features such as saved views. Required contracts still determine compatibility
and are provisioned during approval.

`listViews()` returns each named view's selected result properties in display
order. Property descriptors retain source labels for projected and computed
values. `executeView()` returns their values on each result row.

Provisioning is part of the approval flow. The connector validates and
installs only the missing type definitions, verifies that they expose the
declared contracts, and creates the scoped grant afterward. The application is
not granted collection-wide `create_type` access.

The SDK returns the mdbase operation envelope, carries revision tokens in typed
record results, and accepts `if_revision` on mutations. `describe()` exposes
JSON Schemas, portable type definitions, canonical collection settings, and
optional domain contracts. `watch()` resumes from a local collection cursor;
the Connect server does not store the change feed.
`preflightRename()` and `preflightDelete()` run the canonical collection
operation without changing records or advancing the change cursor, so an app
can show authoritative reference impact before asking for confirmation.
`renameWithProgress()` and `deleteWithProgress()` expose preflight, ready,
applying, completed, and cancelled phases with an impact estimate. Cancellation
remains available during an encrypted local/relay mutation because the SDK
persists its exact encrypted request before dispatch. If waiting is cancelled
after dispatch, `pendingMutation()` reports the interruption and
`resumePendingMutation()` safely recovers the connector's durable receipt using
the exact same input. Other providers are cancellable until apply begins and
then run to a definitive response.
Authorization is retained in `localStorage` by default. Access tokens are
renewed with rotating refresh tokens; passing a custom `Storage` implementation
allows a host to choose another persistence boundary.

Native shells can pass `navigate` to open the authorization URL in the system
browser and list a reverse-domain callback such as
`dev.mdbase.tasknotes://auth/mdbase/callback` in the bundled declaration. Its
scheme must match the declaration ID. PKCE remains mandatory. Call
`completeAuthorization(callbackUrl)` when the application receives the deep
link.

New authorizations require encrypted relay protocol 1 by default. The SDK keeps
a non-extractable per-authorization P-256 key and atomic message counter in
IndexedDB, encrypts operation inputs for the connector, and decrypts connector
results locally. Set `relayEncryption: "disabled"` only for development where
end-to-end relay encryption is intentionally unavailable; an encrypted grant
never falls back to plaintext.

For a hosted collection, the same authorization exchange returns a short-lived,
grant-bound provider capability. The SDK routes operations directly to the
hosted Rust data plane, binds browser requests to the approved callback origin, and does
not send record payloads through the Connect control plane. Refresh rotation,
permission narrowing, and revocation keep the same public SDK behavior across
local and hosted authorities.

`hostedSync()` exposes a provider-neutral sync transport without exposing the
provider credential. It refreshes the grant-bound capability as needed and can
be passed directly to `@mdbase/connect-sync` for an offline application cache.

Record-facing code can depend on `MdbaseCollectionClient` instead of the OAuth
client. It accepts a small `MdbaseCollectionTransport`, which is the stable seam
used by Connect, the developer sandbox, and future hosted providers. This keeps
application logic independent of authorization and deployment topology.
