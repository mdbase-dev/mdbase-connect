## Security

- Require a live exact cached grant for Private relay sessions as well as signed log policy, and enforce local refusals on granted IPC and linked-client sessions without requiring an online lease for Private local use.
- Keep Private lease and missing-cache refusals retryable through the daemon, relay and bounded SDK first-open wait; preserve terminal session Problems and Local lease retry hints without locking unrelated collections' frame traffic.
- Let an Active replacement grant restore a linked client key without reactivating the refused grant ID.
