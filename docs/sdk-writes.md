# SDK: settling a write

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
