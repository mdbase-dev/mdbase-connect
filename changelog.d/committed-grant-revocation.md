## Fixed

- Return the durable application revocation status even when connector policy delivery fails, without skipping audit or reauthorization cleanup. Batch revocation now reads statuses and records audit events in bulk.
- Reconnect after connector policy acknowledgement failures instead of requiring a daemon restart. Authentication failures remain terminal; existing daemon reconnect backoff is unchanged.
