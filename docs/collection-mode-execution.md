# Collection mode controller checkpoint — not enabled

This branch composes the trust foundation and owner handover primitive, with
HTTP-operation proofs, a native step/resume controller, a policy-publication
pause, and hosted/escrow readiness and rebuildable-cache retirement endpoints.
It is not a shippable conversion. `registerCollectionModeExecution` is deliberately
**not called** by the server. No interface controls are added.

## Publication blocker

An older keyed user replica can still consider its current key trusted after the
service revocation (for example, it authored the previous Cloud copy epoch). Its
ordinary rekey-required handler emits `DeviceRevoked`, not `CloudCopyOff`, without
the new local-intent gate. If that peer takes the adjacent slot, replay validity
accepts its rekey but the approved local switch rule correctly refuses it.

The real-key regression
`an_older_keyed_writer_can_consume_the_adjacent_slot_unless_publication_is_fenced`
records that behavior. Pausing CP outbox publication alone cannot fence this
user-device write. Execution needs a qualified mixed-client capability floor or
an existing device-writer fence before the switch can be published. Do not bypass
adjacency, accept the old reason, or extend trust again to work around it.

Older clients may also have already applied a conversion before they upgrade.
Their stored prefix lacks the new local switch-set receipt; arbitrary read-ahead
must not manufacture one. Qualify an upgrade/replay path together with the client
compatibility plan before exposing the control.

## Scope and unfinished qualification

- New HTTP proof binds collection, request, direction, prepare/finish stage,
  epoch and receipt position/hash. No collection-log wire fields are changed.
- The private publisher queues service revocation and state in one transaction.
  Ordinary CP writers and subsequent outbox publication pause until native rekey
  evidence. This does not solve the device-writer blocker above.
- The cloud publisher reuses service generation/custody and enrols services before
  setting Cloud copy, on the existing collection/log/genesis. No service bootstrap
  or replacement epoch is requested.
- A fresh durable native Cloud choice is required for owner handover. Stale host
  configuration cannot release Private keys. Current grants recover authenticated
  history from the original rekey box; a bounded existing control replay can
  repair legacy partial keyrings without changing policy or local trust.
- Native readiness is distinct from app admission: escrow readiness does not make
  escrow an app server. Service acknowledgements are exact-tuple, bounded responses.
- Cache retirement preserves the migration ledger and makes no physical-erasure
  claim. It reuses the existing retirement path and preserves a public device
  marker to reject stale cleanup of a later service identity.

Still required: mixed-version gate/fence, source/receiver upgrade qualification,
Cloud choice projection into both native host files, known-before-publication
failure/cancel reconciliation, authenticated Cloud-choice acceptance on other
devices, SDK and CLI bindings, desktop/portal controls, PostgreSQL controller/race
suites, real Worker lifecycle tests, and the full SDK/daemon round-trip matrix.
Do not treat a compile, an HTTP ACK or a passing diagnostic refusal test as
completed conversion E2E.
