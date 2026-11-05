## Fixed

- Keep renewable local grant lease lapses retryable instead of reporting revocation, and preserve precise local consent refusals on session and relay close.
- Never acknowledge an unpersisted grant-feed snapshot, including identical redelivery; retry persistence after storage recovers without restarting the daemon.
