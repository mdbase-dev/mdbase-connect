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

Application identity is derived from the manifest's exact origin. No developer
account or manually issued client secret is required.

Applications declare required domain contracts in their manifest. Connect only
offers compatible collections and derives the record scope from this declaration:

```json
{
  "manifest_version": 1,
  "name": "TaskNotes",
  "homepage": "https://tasks.example",
  "redirect_uris": ["https://tasks.example/auth/mdbase/callback"],
  "requirements": {
    "contracts": [{ "id": "tasknotes.task", "version": 1 }]
  }
}
```

The SDK returns the mdbase operation envelope, carries revision tokens in typed
record results, and accepts `if_revision` on mutations. `describe()` exposes
JSON Schemas, portable type definitions, canonical collection settings, and
optional domain contracts. `watch()` resumes from a local collection cursor;
the Connect server does not store the change feed.
Authorization is retained in `localStorage` by default. Access tokens are
renewed with rotating refresh tokens; passing a custom `Storage` implementation
allows a host to choose another persistence boundary.

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

Record-facing code can depend on `MdbaseCollectionClient` instead of the OAuth
client. It accepts a small `MdbaseCollectionTransport`, which is the stable seam
used by Connect, the developer sandbox, and future hosted providers. This keeps
application logic independent of authorization and deployment topology.
