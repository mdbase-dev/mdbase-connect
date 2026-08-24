# Hosted collaboration Phase 4B

This development-only slice enables a single provider process when
`MDBASE_CONNECT_HOSTED_COLLABORATION_ENABLED=true`. It uses a bounded,
process-local room broadcast hub; durable PostgreSQL room state and SyncStep1
state-vector reload remain authoritative after reconnect.

Multi-instance routing, proactive revocation disconnects, awareness/presence,
drain coordination, and collaboration readiness/capability advertisement are
explicitly deferred. The flag is fail-closed by default and collaboration is
not advertised through the provider capability response.
