## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1` and `MDBASE_NEXT_HOSTED_INTERNAL_TOKEN` or
  `MDBASE_NEXT_ESCROW_INTERNAL_TOKEN` set, the hosted replica can read each
  collection's state (`standard`, `private`, `local` or `unknown`; a collection that
  has left sync, marked in the new `next_collections.left_sync_at`, is `unknown`) from
  `/internal/v1/next/collections/:id/state` and the batch
  `/internal/v1/next/collections/states`.
