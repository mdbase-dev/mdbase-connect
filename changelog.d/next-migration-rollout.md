## Added

- Staged migration of hosted collections to mdbase-next, driven by the hosted
  migrator over a dedicated token (`MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN`).
  - Operators release cohorts; there is no user opt-in.
  - One global pause (the rollout starts paused) refuses the atomic per-account
    start claim. An account that has started always finishes.
  - Each hosted collection's cutover is recorded only for the control plane's
    cloud copy with the preserved ID, and routes it to the next runtime.
  - The guarded account backend flip is the only setter of
    `account_backend = next`. It requires every settled hosted collection to be
    cut over, and an evidence digest that the server recomputes from those records.
  - A flipped account cannot create legacy hosted collections.
  - A migrating account's collections are never quarantined as missing.
  - Account deletion during migration is immediate and terminal.
  - Every change is an audit event. The `next:migration-rollout` CLI pauses,
    resumes and manages cohorts and records the operator.
