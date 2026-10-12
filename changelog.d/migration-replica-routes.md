## Added

- Migration-token routes for the fence-first collection migration: list, revoke and unrevoke legacy mirror replicas, unfence a pre-cutover legacy collection, and queue the control-plane `migration-cutover` policy (with `freeze false`) naming exactly the replicas the current provider run revoked. Each route requires the current migration claim and provider run and refuses stale, foreign or superseded ones; rollback steps refuse once the cutover policy is queued, and a repeated cutover request finds the queued policy instead of adding another.
- Hosted provider: a read-only internal route listing the replicas whose revocation the current migration run owns.
