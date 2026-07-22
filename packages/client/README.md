# `@mdbase/connect`

Browser SDK for dynamically discovered mdbase connect applications.

```ts
const connect = new MdbaseConnect({
  serverUrl: "https://connect.mdbase.dev",
  manifestUrl: "https://workouts.example/.well-known/mdbase-app.json",
  redirectUri: "https://workouts.example/auth/mdbase/callback"
});

await connect.authorize(["describe", "changes", "read", "query", "update"]);

// On the callback route:
await connect.completeAuthorization();
const description = await connect.describe();
const workouts = await connect.query({ types: ["workout"] });
await connect.update({
  path: "workouts/monday.md",
  patch: { completed: true },
  if_revision: workouts.result.results[0].revision
});

for await (const change of connect.watch()) {
  console.log(change.type, change.payload.path);
}
```

Applications with full collection access can also register and maintain type
definitions. Type source is returned with a revision token so updates cannot
silently overwrite a definition changed by another application:

```ts
const created = await connect.createType({
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

const current = await connect.readType({ name: "workout" });
await connect.updateType({
  path: current.result.path,
  document: current.result.document.replace("version: 1", "version: 2"),
  if_revision: current.result.revision
});
```

Request `read_type`, `create_type`, and `update_type` during authorization.
Contract-scoped applications cannot manage collection-wide type definitions.

For a local collection, ask for same-computer access from a user gesture:

```ts
const status = await connect.checkDirectAccess();
if (status === "permission_required") {
  directButton.onclick = () => connect.requestDirectAccess();
}

connect.onConnectionChange((connection) => {
  console.log(connection?.route); // "direct", "relay", or "hosted"
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

Application identity is derived from the manifest's exact origin. No developer
account or manually issued client secret is required.

Applications declare required domain contracts in their manifest. Connect only
offers collections that are compatible or can be configured safely, then derives
the record scope from this declaration. The manifest may include portable
type definitions for the connector to install during approval:

```json
{
  "manifest_version": 1,
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

Provisioning is part of the approval flow. The connector validates and
installs only the missing type definitions, verifies that they expose the
declared contracts, and creates the scoped grant afterward. The application is
not granted collection-wide `create_type` access.

The SDK returns the mdbase operation envelope, carries revision tokens in typed
record results, and accepts `if_revision` on mutations. `describe()` exposes
JSON Schemas, portable type definitions, canonical collection settings, and
optional domain contracts. `watch()` resumes from a local collection cursor;
the Connect server does not store the change feed.
Authorization is retained in `localStorage` by default. Access tokens are
renewed with rotating refresh tokens; passing a custom `Storage` implementation
allows a host to choose another persistence boundary.

Native shells can pass `navigate` to open the authorization URL in the system
browser and list a reverse-domain callback such as
`dev.tasknotes.app://auth/mdbase/callback` in the public manifest. PKCE remains
mandatory. Call `completeAuthorization(callbackUrl)` when the application
receives the deep link.

New authorizations require encrypted relay protocol 3 by default. The SDK keeps
a non-extractable per-authorization P-256 key and atomic message counter in
IndexedDB, encrypts operation inputs for the connector, and decrypts connector
results locally. Set `relayEncryption: "disabled"` only for an explicit private
protocol-2 migration; an encrypted grant never falls back to plaintext.

For a hosted collection, the same authorization exchange returns a short-lived,
grant-bound provider capability. The SDK routes operations directly to the
hosted Rust data plane, binds browser requests to the manifest origin, and does
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
