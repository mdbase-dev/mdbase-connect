## Fixed

- Retry hosted query serialization and deadlock conflicts with bounded, jittered exponential backoff inside the existing operation deadline, preserving exact replay receipts and quota accounting under concurrent queries.
