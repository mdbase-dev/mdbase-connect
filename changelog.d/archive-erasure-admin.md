## Added

- Service-local `auth-admin archive drain-deletions` reuses existing deletion workers before migration freeze and refuses unless the current unfrozen cohort and all three deletion queues are strictly known empty. Results are observations, not physical-erasure receipts or capture authorization.
