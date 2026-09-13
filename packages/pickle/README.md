# `@mdbase-dev/pickle`

Contract adapter and provisioning resources for Pickle collections.

```ts
const pickle = new PickleCollection(connect);
const requests = await pickle.list();
await pickle.respond(requests[0], {
  decision: "approve",
  comment: "Looks right."
});
```

The adapter uses ordinary mdbase operations. Request state is derived from
linked response records, and no record payload is stored outside the collection.

For an inbox, use `pickle.list({ includeBody: false })`. It still waits for all
response links before deriving pending, answered, and conflict states, but does
not transfer every request's Markdown context. Fetch an opened request's context
with `await pickle.readBody(request, { signal, timeoutMs: 10_000 })`. Response
bodies are never needed for lifecycle calculation and are omitted from queries.

Pickle requests 256 records per page from the first query. Cursor authorities
pin that initial size; continuation requests reuse the cursor rather than asking
for an ineffective larger limit.
