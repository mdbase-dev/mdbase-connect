## Fixed

- Hosted replicas resume record-index repairs across wakes instead of rewriting the collection on every retry. Their log cache no longer writes unused body and field search projections.
- Connected change watchers are notified when catalog repairs finish. A hosted cache that fails verification after a later repair slice is discarded and retried without waiting for eviction.
- After sliced replay, connected watchers receive a reset and live queries receive a fresh snapshot. Transient store faults reopen from the last durable repair checkpoint; failed cache drops retain the normal open backoff.
