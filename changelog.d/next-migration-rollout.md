## Added

- Staged migration of hosted collections to mdbase-next: operator-released
  cohorts (no user opt-in), one global pause that stops new accounts from
  starting without stranding an account mid-cutover, and a guarded account
  backend flip. The flip is the only setter of `account_backend = next`. It
  succeeds only when the hosted migrator names exactly the account's settled
  hosted collections, and it records that evidence. The rollout starts paused
  with no cohorts. Routes accept only the hosted service token; the
  `next:migration-rollout` CLI pauses, resumes and manages cohorts.
