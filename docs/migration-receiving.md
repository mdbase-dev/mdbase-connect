# Staging migration receiving DATA

The existing dedicated migration-token route
`GET /internal/v1/next/migration/cohorts/{name}/archive-binding?view=receiving-v1`
returns complete bounded receiving metadata. Without the query, its original
four-field archive binding is unchanged. The variant requires configured LAB or staging,
a strict query, an empty body and ordinary dedicated-token authentication; all
responses are `no-store`. It does not accept origin, credential or resource selectors.

The exact root is `{schema,binding,frozen_at,archive,members,cutover_evidence_digest}`,
with schema `mdbase-migration-receiving/1`:

- `binding` is the existing four-field membership binding; `archive` is
  `{accepted_at,verified_result}`, checked by the canonical current-archive,
  freeze, environment and freshness rules. There is no second verifier.
- `members` is the complete sorted frozen membership, including suspended,
  collectionless and terminal-excluded accounts. Each member is
  `{view,suspended,started_at,terminal_excluded_at,cutovers,flip}`. `view` is the
  existing ten-field account view; `cutovers` uses the same strict eight-field
  recorded-collection serializer as the authorized native reader.
- `flip` is null or `{collections,evidence_digest,flipped_at}`. Its collections
  are the **current** frozen held set, checked against stored flip evidence.
  This is not an original successful command-set receipt.
- The aggregate digest is null until the current hosted set has complete,
  nonempty, settled cutover records; otherwise it uses the canonical sorted
  `collection:barrier_f:final_digest\n` digest. An empty SHA-256 is never positive
  receiving evidence. Sequence strings are lossless; numeric write limits remain.

Before acceptance, the separate [capture inventory view](migration-capture.md)
provides complete metadata without starting accounts or authorizing exports.

One repeatable-read transaction holds the existing batch lock. Other receiving
queries do not acquire user/hosted row locks afterward, avoiding lock inversion
with effects. Concurrent changes to the locked batch fail closed. This snapshot
is not a lease: effect transactions still perform their currentness checks.

Output exceeding 1000 members, 1000 held hosted collections or 1 MiB encoded JSON
refuses rather than truncating or paginating. These are serialization limits, not
qualified database memory, storage or throughput bounds. Consumers must enforce
their smaller invocation limits. Bulk metadata never enters native completion;
native row/byte limits and exact original microsecond run identity remain separate.

Recorded timestamps, backend flags and idempotency do **not** prove an original
successful POST. The runner must retain and compare its original private intent
and known-success receipt. An earlier UNKNOWN cannot be adopted through this GET.
Suspension is preserved; dedicated migration does not restore ordinary access.

The provider fence/source fronts similarly bind observed migrating run identity
across awaits. A provider result is not an all-writer, external-I/O or shared-key
issuer drain acknowledgment. A failed or lost response may follow a committed
effect: do not infer undo, cancellation or restore. Existing exact provider-local
rollback receipts are separate from native saved-action/currentness authority;
they are not general post-cutover reversal or permission for recovery dispatch.
