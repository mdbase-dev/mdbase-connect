## Fixed

- Refuse Private collection creation, device enrollment, and approval requests with `409 collection_deleted` when the collection identifier has a permanent deletion fact (for example, after collection or account deletion), matching cloud-copy bootstrap and preventing parked genesis outbox batches.
