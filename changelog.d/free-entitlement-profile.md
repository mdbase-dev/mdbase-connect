## Added

- A `free_v1` entitlement profile for the mdbase-next free plan: one synced
  collection, a provisional 250 MB storage cap, one member seat and files up to
  100 MB. No account holds it until an operator runs
  `auth-admin entitlements backfill-free`, which grants it to every account in
  bounded, idempotent batches. Beta accounts keep their limits, because effective
  limits are the maximum across an account's profiles.
