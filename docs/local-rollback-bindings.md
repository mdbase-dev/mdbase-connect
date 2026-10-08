# Fenced local rollback binding preparation

With the Next control plane enabled, native clients may call
`POST /v1/next/migration/local-rollback/rotate-bindings` while the local marker is
still fenced. Authenticate with the ordinary current native pairing token; an
enrolled desktop/CLI device and a nonsuspended backend-Next account are required.
Scoped app-runtime/mobile installation credentials and browser sessions cannot
manage these legacy bindings.

Body (no local paths or payloads):

```json
{
  "legacy_connector_id": "<old connector UUID>",
  "legacy_collection_ids": ["<every registered old local UUID>"],
  "collection_id": "<target local UUID>",
  "rollback_id": "<caller-durable UUID>"
}
```

The old connector must belong to the current account and differ from the caller.
Inventory is the exact registered `collections.local_id` set (`present` and not
removed), including authority-retired rows that remain registered. At most 1,000
collections and 1,000 active bindings for the target are supported. An old retired
credential is never used for authentication or implicitly restored.

Response:

```json
{"collection_id":"<target>","rollback_id":"<same ID>","bindings":[{"grant_id":"<UUID>","key_id":"<new binding ID>","scope_epoch":4}]}
```

Grant rotations and the immutable receipt commit in one transaction. Deduplication
is `(collection_id, rollback_id)`, bound to the authenticated account, old connector
and full canonical inventory. Concurrent identical requests/retries return the
same result. Conflicting reuse, changed inventory or active-binding drift returns
409. Current credentials, ownership and revocation are checked on every replay.
An unknown outcome retries the same rollback ID, never a new one.

These tuples are identifiers, **not permission or public-key authority**. Before
unfencing, the old daemon must durably prepare and verify an authenticated complete
current legacy policy snapshot or an exact verified pre-rotation identity/active
set. Drift fails closed; an empty active set means authorize none. Do not relabel
stale cached scopes with new epochs. The endpoint leaves account backend, connector
revocation, grant activation, permissions and Next policy unchanged. It does not
make an old daemon safe to start by itself.
