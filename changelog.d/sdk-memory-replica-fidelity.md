## Changed

- SDK testing: `MemoryReplica` refuses a paging cursor with `invalid_request` / `cursor_stale` once the collection has changed, and compares a query's type names without ASCII case, both as the real replica does. A test that pages while it writes now sees the refusal an app would see.
