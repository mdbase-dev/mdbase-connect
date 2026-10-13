# Isolated LAB migration hosted routing

The optional LAB override routes one operator-configured **account UUID** to a
separate hosted deployment. No account label, HTTP account field, grant owner
supplied by a caller, or new-account default selects a destination. It does not
change custody inside an existing Worker.

Configure all four settings together:

- `MDBASE_NEXT_LAB_MIGRATION_ACCOUNT`: exact approved account UUID.
- `MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL`: HTTPS origin of the separate migration Worker.
- `MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN`: CP outbound service credential; matches
  the separate Worker's `HOSTED_SERVICE_TOKEN`.
- `MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN`: separate hosted-role inbound
  credential; matches that Worker's `CP_INBOUND_TOKEN`.

Startup refuses partial configuration, non-LAB identity, the ordinary hosted
Worker origin, shared credentials, disabled factories/client discovery/migration
fronts, or concurrent isolated PITR routing. Existing `MDBASE_NEXT_HOSTED_*`
settings remain the default. Escrow routing is unchanged. The dedicated migration
credential remains `MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN` on CP and
`CP_MIGRATION_TOKEN` on the Worker, distinct from both directions above.

Existing collections resolve their owner through authoritative retained native,
hosted, local and logical identity mappings. Ambiguous ownership fails closed.
A not-yet-registered collection's factory uses only the authenticated creator
whose identity the existing bootstrap rechecks around network effects. Neither
migration admission nor policy wakes has that creation fallback. App discovery
uses the owner in the same authenticated grant/parent query, not the caller's
account (members may belong to another account).

The account override covers hosted service-device generation, durable policy
wakes, migration admission and direct Noise discovery. Hosted record, state,
log-token and CPP claim readers reject the wrong deployment credential for the
resolved owner; mixed-account state batches are refused. The escrow credential
retains its existing kind-scoped behavior.

This configuration is routing, not migration approval, key readiness or serving
authority. Enable it only after the separate Worker's real KMS configuration,
qualified source/WASM, signed build trust and fixture scope are ready. Removing
the override is not a data rollback: it does not restore DO state, credentials,
provider fences or an account backend flip. A deployed code version is also not
such a rollback.
