# `@mdbase/pickle`

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
