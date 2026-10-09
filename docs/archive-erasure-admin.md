# Pre-freeze deletion drain (service-local administrator)

Considered auth-admin, deletion workers and lifecycle diagnostic aggregates; reused the existing admin/request envelope, workers and guards, with a new fixed aggregate because diagnostics are not the exact three-queue emptiness witness.

## Interface and limits

```text
auth-admin archive drain-deletions --cohort <name> --expected-revision <40-lowercase-hex-sha> --operation-id <uuid> --actor <id> --reason <text>
```

Use the existing authenticated operator/deployed-service job boundary and encoded `auth-admin request` envelope, with configured service-local DB/provider credentials. There is no new public endpoint, token, workstation SQL, credential override or caller-selected worker limit. The CLI's existing migration-currentness assertion runs first.

`expected-revision` must exactly equal the existing `MDBASE_CONNECT_REVISION` runtime context. It names the qualified deployed Connect source build, NOT membership revision, a short SHA, executable attestation or independent provenance proof. Missing/mismatched revision or provider configuration refuses before work. Actor/reason are audit metadata only, not returned content.

The target cohort must exist and be unfrozen before effects. Reuse one pass of `drainDeferredAccountDeletions(db, 25)` and `ProviderRevocationWorker.drain(5)` (five jobs total across its two queues), preserving ready-at, current freeze, delivery timeout, retry and completion guards. No forced readiness, unfreeze/re-freeze, sleep loop or alternative eraser. Other accepted ready work may be processed because the canonical workers and emptiness check are global.

The final single read-only SELECT observes the target's current membership revision/unfrozen state and all three queues in the same statement snapshot. It counts EVERY deferred account row, and provider collection/revocation jobs where `completed_at IS NULL OR state <> 'completed'`, including future, sending, unready and inconsistent jobs. A zero drain count is never emptiness. Require exactly one cohort row, canonical revision and real booleans; every queue flag and unfrozen flag must be exactly true.

Observation statement timeout is 5s and lock timeout 250ms. Worker queries/connections retain `postgresPoolConfig` bounds (connection 5s, query 20s, statement 15s, lock 5s, idle transaction 10s) and the existing provider request bounds. These are per-IO/attempt bounds, not a promise that every pass fits the wrapper's total deadline. Wrapper timeout/cancellation/lost response must remain UNKNOWN and require explicit reconciliation; never retry automatically.

## Closed result and failure

The existing `MDBASE_ADMIN_RESULT` envelope contains exactly:

```json
{
  "schema": "mdbase-archive-erasure-preflight/v1",
  "operation_id": "12345678-1234-1234-1234-123456789abc",
  "runtime_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "membership_revision": "7",
  "unfrozen": true,
  "queues_empty": {
    "deferred_accounts": true,
    "provider_collections": true,
    "provider_revocations": true
  },
  "completed": { "accounts": 0, "provider_jobs": 0 }
}
```

Standard argument-parser errors or fixed `archive_erasure_*` refusals use the existing nonzero error envelope. No partial success/empty result follows a query, worker or audit failure. Raw DB/provider diagnostics and account/collection/content/key/path identities are not emitted by this command. Existing audit events record started and observed-empty attempts; operation ID correlates an attempt, NOT cached/idempotent execution. Repeating it performs a fresh check and may mutate again.

Successful provider job completion is not object/version-removal proof. Existing lifecycle cleanup and listing/removal evidence remain separate. This result is neither a reusable empty receipt nor a capture/restore/live-operation GO.

## Check-to-capture timing evidence

Coordinator12:56 accepts the observation-to-freeze gap without an atomic all-three freeze recheck. The drain is best-effort hygiene to keep the archive small, not a correctness or physical-erasure proof. Existing `setCohortFrozen` still checks only ready deferred rows for that cohort; this command does not stop deletion acceptance.

The trusted operator runner must record check time and actual capture start `S` in run evidence, and enforce check-to-`S` ≤24h. Record a conservative UTC check-start bound BEFORE dispatching this fresh command (never a response/completion timestamp or caller-supplied assertion). A deletion accepted between the actual check and freeze has `D` at least that earlier bound, so `V ≤ E+2d ≤ S+119d ≤ D+120d`. Reject missing/uncertain timing or an exceeded window. Keep actual `C−S` ≤24h and the existing retention/removal checks separately.

Release owns the wrapper/evidence/deadline integration and explicit UNKNOWN reconciliation. No automatic retry, cached empty observation, new store/authority/H0 fields or rewritten historical receipts. Source qualification and this timing decision do not grant live-operation GO.
