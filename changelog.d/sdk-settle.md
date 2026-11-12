## Changed

- SDK: `client.settle(write, options)` replaces `client.save()`. It takes a write, the promise of one or a mutation ID and returns one of `confirmed`, `saved_on_device`, `conflicted`, `rejected` or `unknown`, with the receipt, the problem and, with `read`, the record read back (optionally through a contract). A submit failure is checked against its receipt, so a write the replica captured is never reported as failed, and an `unknown` write is settled later by its mutation ID without being submitted again. `SaveResult` is removed.
- SDK: `update`, `replaceDocument`, `rename` and `delete` set `recordId` on the write they return, and `isProtected(record)` is exported.
