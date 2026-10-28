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
user-device write. Co selected a per-collection capability floor: arming/publication must require
all active keyed user devices to have durably advertised switch awareness,
including offline devices. Below-floor devices must be refused on subsequent
collection operations. The floor must never decrease. Do not bypass adjacency,
accept the old reason, or extend trust again to work around it.

No collection switch has shipped: phase 1 records intent only. An upgrade path
for older clients that already applied a switch is not required.

The implementation must account for cached credentials and existing epoch keys:
refusing future CP requests does not itself invalidate either. Device key grants
and rekeys are sent directly to the log. The log's existing device authorization
checks active enrollment and the token-bound signing key, not CP capability
metadata. Do not claim the raw older-writer regression is prevented by CP-only
checks until this authoring boundary is qualified.

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

Still required: capability gate and monotonic floor qualification,
Cloud choice projection into both native host files, known-before-publication
failure/cancel reconciliation, authenticated Cloud-choice acceptance on other
devices, SDK and CLI bindings, desktop/portal controls, PostgreSQL controller/race
suites, real Worker lifecycle tests, and the full SDK/daemon round-trip matrix.
Do not treat a compile, an HTTP ACK or a passing diagnostic refusal test as
completed conversion E2E.
