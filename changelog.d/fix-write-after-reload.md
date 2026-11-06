## Fixed

- Hold writes with incomplete restored key history as pending while attempting authenticated history repair; never emit an Entry without its idempotency token. Retry refused appends with capped exponential backoff and expose a non-durable sync incident without rejecting or dropping captured writes.
- Release the file-upload lane when cancellation races commit, without discarding an already captured write, so Stop does not block the next upload.
