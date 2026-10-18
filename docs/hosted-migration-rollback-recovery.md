# Receipted rollback: owner namespaces, detached custody and exact-original redrive

Status: design for review; not implemented or deployment authority. These are
production migration blockers. Existing UNKNOWN actions, intents and receipts
must not be edited, cleared, relabelled or replaced to make recovery succeed.

## Proven failure boundaries

Connect's migration claim owner is `hosted_collections.user_id`, a Connect user
UUID (`migration-provider.ts::claim`). The Worker and native RunBinding preserve
it; native receipt qualification compares `owner_account_id` against that UUID.
Connect currently sends that same UUID as provider `owner_account_id`.
The provider instead compares it with `hosted_provider_collections.account_id`,
its storage-account UUID. `account_storage_accounts(user_id,provider_account_id)`
maps these independently allocated identities. Normal non-identity mappings
therefore fail every first Connect/native receipted pre-cutover rollback.

Other legacy lifecycle/revocation calls address a collection UUID and send state
or replica IDs, not this owner field. Their success does not qualify rollback.

Separately, ABI pending-finish clears the opaque slot, not JournalDriver.pending.
Opening a new claim reuses that Driver; unknown receipt-scope lookup then refuses
because it still has prepared RAM custody. ABI zero is decoded as empty CBOR,
producing an unclassified exception before any receipt request or settlement.
Cold SQL resume works; runtime eviction is not an operator recovery protocol.

## 1. Connect/provider owner boundary (owner repository: mdbase-connect)

Keep the seven-field native correlation binding and existing CP rollback-intent
unchanged, including `owner_account_id` in the **Connect namespace**. Do not
translate an original receipt after receiving it, weaken native owner equality,
or replace an already recorded intent with a different owner/action/epoch.

Introduce an explicit provider v2 request boundary:

```
POST /internal/v1/collections/:id/legacy-migration/rollback-v2
POST /internal/v1/collections/:id/legacy-migration/rollback-receipt-v2

{
  "provider_account_id": "<mapped storage-account uuid>",
  "binding": {
    "owner_account_id": "<Connect user uuid>",
    "provider_migration_id": "<original provider run>",
    "authority_epoch": 1,
    "fixed_head": 2028,
    "driver_id": "<original Driver>",
    "action_id": "<original rollback action>",
    "replica_ids": []
  }
}
```

The actual epoch is derived/checked, never the illustrative constant above.
The server, not operator input, selects the mapping from the exact current
Connect user. Missing, ambiguous or changed mappings refuse. Recheck the owner,
epoch, mapping and run around awaits and in the final publication transaction.
Record the physical provider-account binding once before dispatch, beside the
existing immutable seven-field intent; reject conflicting readback. Retain old
intent bytes, including an intent recorded before this repair.

The authenticated provider v2 checks its collection's actual account_id against
provider_account_id and checks epoch/run/head/drain/retention/replica scope under
the existing collection lock. The original seven-field binding is correlation
in the Connect namespace; producer authorization and the physical storage-owner
check are separate. Provider persists both namespaces atomically with restore,
active transition and receipt. The returned receipt keeps the existing exact
four-field shape and seven-field binding, now produced correctly in the Connect
namespace. Connect returns it unchanged; native's ten-field CBOR receipt, digest
and original-owner checks remain unchanged.

Add a nullable physical-owner column to the existing provider receipt table in
an append-only migration, without rewriting historical receipts. New v2 writes
it. NULL identifies actual legacy v1 receipts: v2 may read them only when the
original owner and requested physical owner are equal AND the complete original
binding matches. Never reinterpret a legacy provider owner as a different
Connect user. Preserve supersession and exact historical receipt timestamps.

V1 remains only for the deployed predecessor during coordinated upgrade; it
retains its old checks. New Connect uses v2 exclusively, with no fallback to v1,
UUID identity assumptions or bare active/restored results. Remove v1 routes once
all CP clients/operator consumers have moved; legacy persisted receipts retain
the explicit identity-only read rule until those rows are legitimately removed.
Deploy/qualify provider v2 before enabling the new CP caller.

Files:
- `services/server/src/features/next/migration-replicas.ts`: mapped physical
  owner qualification, immutable original intent and mapping correlation.
- `services/server/src/hosted-provider-legacy-migration.ts`,
  `hosted-provider-replies.ts`, `hosted-provider.ts`: explicit v2 transport DTO;
  preserve the original receipt unchanged.
- `crates/connect-hosted-provider/src/http/legacy_migration.rs` and
  `provider/collections/legacy_migration.rs`: v2 request and owner comparison;
  original transaction/receipt semantics retained.
- Next append-only provider migration: physical storage owner in receipts.

Required tests:
- Real PG CP fixture with DIFFERENT user/provider-account UUIDs; fake transport
  must actually check the storage owner, not just epoch. Current fixture misses
  that predicate. Golden request/response and no post-hoc receipt rewriting.
- Real PG provider v2 with non-identity owners; wrong physical owner, epoch,
  collection/run/head/replicas refuse without effects. Exact replay/read returns
  identical original receipt; changed binding/mapping, supersession and active
  without receipt refuse.
- Existing wrong-owner CP intent remains byte-for-byte intact and is reused;
  new v2 dispatch keeps its seven-field binding. Missing mapping and drift never
  queue an effect. Identity-only legacy receipt upgrade/read tests.
- Joined CP HTTP + real provider PG integration (not two independent mocks), plus
  original native/workerd receipt settlement with a non-identity storage owner.

## 2. New-claim Driver custody (owner repository: mdbase-next)

At `crates/hosted-worker/src/abi.rs::migration_open`, a fresh owned CPP claim must
not reuse a detached prepared or poisoned Driver when no opaque action/physical
slot remains. Resume the exact existing run from SQL in that case. Keep the
healthy warm Driver fast path; no unconditional per-action DDL/reopen is needed.
A narrow Driver predicate derives this need from existing pending/poisoned state;
no new persisted flag. Never replace a Driver while a live action/physical slot
exists. New instance identity invalidates stale RAM tickets; the original SQL
UNKNOWN, action ID, sequence, fingerprint and checkpoint remain untouched.

Handle ABI-zero explicitly in `Engine.migrationUnknownRollbackScope` as a finite
read-only refusal, rather than decoding empty CBOR. Do not broadly allowlist
platform/CBOR exception text. Native/CPP/physical gates remain authoritative.

Tests must cover the SAME warm Native/WASM/workerd instance: failed provider
call -> exact ABI pending-finish -> new owned claim -> unchanged scope lookup.
Also stale handle/physical-slot refusal, poisoned lost-write reload, no reseal or
new action, no state mutation on refused scope, and physical ACK loss. Existing
cold-reopen tests do not cover this defect. The native warm-scope counterfactual
red is retained separately; a green characterization is not a repair.

## 3. Exact-original rollback redrive (owner repository: mdbase-next;
## existing claim-bound CP/provider endpoints remain effect owners)

There is currently NO operator that can redrive an outstanding rollback after
receipt lookup proves no receipt: resolve only reads; rollback/restart refuse an
outstanding action. Fixes 1 and 2 alone do not close an already-refused action.

Proposed explicit intent:

```json
{"collection":"<uuid>","operation":"retry-rollback","expected_run_sequence":1,"expected_action_sequence":146}
```

It cannot accept a binding, receipt, outcome, ACK or force flag. Only kinds20/21
in the exact current RollingBack run qualify. Require fresh owned CPP, genuine
native pre-cutover/current target and original provider context, exact saved
checkpoint/action/fingerprint, and the real physical collection/generation.
First perform read-only original receipt lookup. If a genuine receipt exists,
settle the original action and physically confirm it; do not dispatch an effect.
Transport uncertainty, malformed/conflicting/superseded receipt or unavailable
source is UNKNOWN, not permission to redrive. Only the provider's authenticated
exact-bound receipt-unknown response plus the same current fenced source may
proceed. An original=true scope is lookup-only; never rerun that Unrevoke under
a different Unfence action.

Native may then reacquire effect custody for the SAME original SQL action,
sequence, Driver, action UUID, fingerprint and before-checkpoint, not append a
new journal action or replace its intent. Physically confirm that exact pending
before effect dispatch. CP sends the same original seven-field intent via the
qualified physical-owner v2 boundary. Provider's atomic exact-binding idempotency
handles a concurrent/delayed original request: either returns the identical
original receipt, never a second logical restore. Native consumes the complete
receipt and confirms the original settlement using actual storage.sync before
resuming. Any lost ACK preserves UNKNOWN; reconcile before another effect.

Files: native `migration_action_ledger/recovery.rs`, `rollback.rs`, ABI;
Worker `migration-operator.ts`, `worker.ts`, `engine.ts`; reuse existing receipt
client/adapter and canonical active-pending view. Do not add another rollback
state machine, caller-proof path or generic UNKNOWN replayer.

Required tests: real warm workerd k21 and k20; original refusal then exact146
redrive and receipt-backed21; delayed original races redrive in both orders;
readback after response/storage ACK loss; wrong sequence/run/owner/mapping/head/
replicas, new cutover, changed physical actor/generation and ambiguous outcome
all refuse. Assert original intent/action/receipt immutability and no additional
journal action on redrive. Original=true Unfence remains read-only.

## #71 disposition

The last authorized read showed20/fenced/146 outstanding; cancellation145 stays
recorded. The coordinator has chosen lease forfeit as **non-closure**. Preserve
all receipts/status/UNKNOWN and the original failed migration result. Do not
claim21, clear146, release unrelated holds, or run another operator action.

A later explicitly authorized recovery needs all three repairs qualified and
installed, exact mapping/intent/source/currentness readback, then the bounded
same-original recovery above. If no original receipt exists, another resolve
alone cannot help. Forfeit is custody/lease disposition, not successful native
rollback or provider restoration.
