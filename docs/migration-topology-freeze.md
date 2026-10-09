# Hosted migration topology freeze

This is a source contract, not authorization to operate a migration environment.
It does not qualify archive recovery, native takeover, hosted WASM memory, or a
production window. Existing migration-token and archive-verifier boundaries are
unchanged; no credential is obtained from a binding GET.

## Window ordering

1. Drain/fence legacy data writes first (H6). Freeze the batch with the dedicated
   migration-token-only `POST /internal/v1/next/migration/cohorts/{name}/freeze`.
   Supply the existing operator identity as `actor` and a nonempty `reason`.
2. Read the existing four-field archive binding. Capture the ONE batch archive
   after the current freeze stamp, with the required retention and verification.
3. Accept the verified archive for the current membership revision. Binding GET
   is read-only: it does not latch state, grant permission, or forbid cancellation.
4. Start, migrate/cut over every hosted collection with its original ID, and flip
   each account using its validated evidence. Local collections are excluded.

`POST …/cohorts/{name}/unfreeze` requires the same token, actor and reason. It is
refused if an acceptance exists for the current revision; the check and change
hold the cohort lock together. Freeze retries preserve the original stamp.
A new freeze cannot start while ready terminal erasure from a previous window
is pending. Archive capture before the current freeze is refused.

## Transaction boundary

The mutation's **actual transaction client** locks accounts in UUID order,
current memberships, then both owners' cohorts in name order, before any
provider/reference effect or publication. Cohorts are locked `FOR UPDATE` up
front because revision triggers update the same parent. Locks stay held through
provider awaits, compensation and commit. Five-second lock contention returns a
content-free retryable refusal. State is inspected after the lock wait, never
filtered away with a frozen-state predicate.

Split import/adoption flows preserve their durable staged/activation intents.
After that intent commits, the provider/publication phase begins a fresh
transaction and rechecks the guard and current intent before any effect. A
freeze between phases therefore leaves a resumable intent without a provider
side effect. No nested or second-client transaction is used while a guard is
held. Missing-collection quarantine during reconciliation uses that same client.

## Account deletion

During a freeze the user receives immediate acceptance and loses sessions,
connector credentials, grants and provider token access immediately. Terminal
account/hosted topology and provider erasure are **not** delivered at acceptance.
The durable request records its batch revision and freeze stamp atomically with
revocation. Readiness is recorded under the cohort lock only after all current
batch members have validated final flips, or an audited unfreeze. The existing
bounded recovery poller drains ready work at startup and periodically; the
final-flip/unfreeze path also drains after its readiness commit. The same erasure
pipeline serves immediate and deferred deletion. Retry/restart cannot turn an
acceptance into a lost request or duplicate completed erasure.

## Ingress/effect map

Paths below are under `services/server/src`. Tests are synthetic local fixtures;
PostgreSQL execution qualifies locks, not real provider RPCs or cryptography.

| Ingress | Guarded call site | Regression coverage |
|---|---|---|
| Account/connector create and onboarding | `features/hosted/service.ts` create + caller-client insert | `migration-topology-routes.postgres.test.ts` alias refusal/no effects; `migration-topology.postgres.test.ts` two creates vs freeze |
| Rename/delete, including former account inline bypass | Shared hosted service uses actual collection owner before child lock/effects | Route aliases above; central rename/delete and unfreeze |
| Local→hosted initial intent, prepare replay, complete/reservation, abort | `features/authority-transfer/local-to-hosted-routes.ts` | `authority-import-abort.postgres.test.ts` frozen roots, provider wait vs freeze, durable/concurrent activation, inventory serialization |
| Hosted→local request/approve/prepare/complete/abort | `features/authority-transfer/hosted-to-local-routes.ts` actual hosted + target owner | Route PG suite runs reference and synthetic provider branches; existing `authority-transfer.test.ts` |
| Adoption approve/exchange/replay/activation/abort | `features/authority-adoption/routes.ts` | Route PG suite: frozen phases, uncertain completion preserves activating intent, guarded resume; existing adoption tests |
| Adoption expiry invoked by POST/GET/approve/exchange | `features/authority-adoption/adoption-store.ts` locked discovery, provider abort + cleanup | Central PG expiry; existing interrupted-expiry retry test |
| Scheduler/GET transfer expiry and import-abort publication | `features/authority-transfer/lifecycle.ts` | Recovery PG races/currentness/bounded discovery, frozen page does not starve unrelated recovery; central frozen directions |
| Account cancellation recovery, including missing historical target | `features/authority-transfer/account-cancellation.ts` before provider fence | Central PG frozen present/missing target; existing abort PG tests |
| Reference reads restoring expired hosted transfer | `hosted.ts` actual guarded reference transaction | Central PG read cannot restore frozen expired transfer; existing reference transfer tests |
| Quarantine and provider deletion delivery | `hosted-capability-lifecycle.ts` actual owner; same-client quarantine and deletion transaction | Central PG preexisting deletion job/no effect until unfreeze; existing lifecycle tests |
| Provider account reconciliation/adoption of unassigned collection | `entitlements.ts` guarded transaction + `auth-admin-entitlements.ts` same-client missing callback | Central PG frozen refusal and no second-client quarantine deadlock; existing entitlement/operator tests |
| Account terminal erasure | `account-management.ts`, readiness in `features/next/migration-rollout.ts`, existing app poller | Central PG whole-batch delay, atomic revocation/request, restart interruption, idempotence and re-freeze refusal; account-management tests |
| Cohort assignment into frozen batch / absent membership race | `features/next/migration-rollout.ts` account locks before cohort | Central PG assignment wait/frozen refusal and both-owner ordering |
| Grant/contract-only setup | Hosted approval service creates no hosted collection or owner/authority transition | Existing authorization/setup tests; explicitly allowed by the product scope, not a topology exemption |

No direct legacy hosted owner-transfer update exists in the audited source.
Any new owner-transfer path must supply both actual owners together; guarding
only the requesting member is insufficient.
