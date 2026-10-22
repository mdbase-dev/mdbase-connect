# Computer last-seen status

The portal uses a 45-second last-seen window for registered computers. Previously
relay connection setup wrote `last_seen_at`, but later verified policy ACKs only
updated the policy-ACK timestamp. A healthy long-lived Native relay could therefore
age out of the portal's online window despite acknowledging its existing
20-second policy renewals.

The existing verified ACK update now also refreshes `last_seen_at`. It retains
revision, connector generation, current socket, revocation and suspension checks.
There is no new heartbeat, browser polling, broker command or database write.
ACKs refused by policy validation or already retired at verification do not
refresh presence. This is a connection hint, not
proof of an application grant becoming Effective or physically materialized.

The older observed Native-online / later portal-Offline reports were not
simultaneous samples. Source-only regression tests establish this specific stale
timestamp counterexample independently; they do not reconstruct that interval.
