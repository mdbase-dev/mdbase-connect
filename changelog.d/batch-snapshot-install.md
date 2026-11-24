## Changed

- Batch snapshot-install persistence in the runtime replica: evaluate each historical control page in memory and persist it in a single commit instead of one commit per control item, and fetch up to six snapshot chunks concurrently and stage each completed wave in manifest order inside one deferred-durability transaction.
