## Fixed

- The log service answers a retried append that already landed with its original receipt, even when the collection is now over its storage quota, instead of `quota_exceeded`.
- Compaction now deletes expired idempotency tokens of entries it has already archived, so the token table no longer grows with the whole history (Durable Objects, Postgres and memory backends).
