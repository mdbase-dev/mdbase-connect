## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1` and `MDBASE_NEXT_HOSTED_INTERNAL_TOKEN` or
  `MDBASE_NEXT_ESCROW_INTERNAL_TOKEN` set, the hosted replica can read each
  collection's state (`standard`, `private`, `local` or `unknown`) from
  `/internal/v1/next/collections/:id/state` and the batch
  `/internal/v1/next/collections/states`.
