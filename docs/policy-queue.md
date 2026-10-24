# Policy queue: parked batches

The control plane turns each collection's pending policy changes into signed
items and appends them, in order, to the collection's log. A batch's bytes and
position are stored before it is sent and never change afterwards.

## Retried, not parked

A failure that is not a refusal from the log service is retried with the same
bytes. That covers timeouts, lost responses, 5xx responses, and any error reply
that is not the log service's own CBOR error frame, such as a 403, 413 or 429
from a proxy or the edge. The poller backs off a failing collection
exponentially, from 4 seconds up to 5 minutes, and resets once a drain succeeds.
A share or removal made while the queue is retrying still tries to publish at
once and returns 503 if that attempt fails.

## Parked

A collection's queue parks, and later work waits behind it, when:

- the log service refuses a batch with its own error (for example `forbidden`);
- a lost batch's reissue can't be signed, for example because the policy
  certificate has expired;
- a lost batch can't be reissued at all: `lost_genesis` or `invalid_retained_ops`.

While a queue is parked, shares and member removals for that collection return
503. Other collections are unaffected.

## Alerting

`/ready` reports queue health without failing readiness. One collection's
parked queue must not take the whole service out of rotation, or block a
release:

```json
{ "ok": true, "service": "mdbase-connect",
  "next_policy": { "parked_batches": 0, "oldest_unsent_seconds": 0 } }
```

`parked_batches` counts parked batches across all collections. Page on any
value above zero. `oldest_unsent_seconds` is the age of the oldest policy work
not yet in a log, parked or retrying. A send that keeps being retried shows up
only here. The field is present only when the next control plane is
configured.

## Resuming

Find the parked batches, fix the cause, then resume:

```sh
DATABASE_URL=… pnpm --filter @mdbase/connect-server next:policy-queue status
DATABASE_URL=… MDBASE_OPERATOR=<your name> \
  pnpm --filter @mdbase/connect-server next:policy-queue unpark <collection id> <reason>
```

`unpark` takes the collection's policy lock and returns each parked batch to the
step it was parked at. A refused send is sent again with the same bytes and
position. A lost batch whose reissue couldn't be signed is reissued. Batch
contents are never rewritten or merged.

Each resumed batch is recorded as a `next_policy.unparked` audit event, with
the batch, its last error and attempts, the reason and the operator. Running
`unpark` again with nothing parked changes nothing.

If the cause is still there, the batch parks again. A lost batch that has
nothing left to send (`lost_genesis`, `invalid_retained_ops`) can't be resumed
unchanged, so `unpark` refuses it and changes nothing.

The running server picks up a resumed queue on its next poll, within a few
seconds.
