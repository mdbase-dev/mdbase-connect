# Hosted semantic projection cutover

Status: final Candidate B production-cutover design; production execution still requires the explicit rollout approval gate.

The live production baseline is beta69 with successful SQLx migrations 1–34. The final cutover adds exactly:

- `0035_hosted_semantic_projections.sql`: versioned semantic projections, relationship graph, generation/rebuild state, integrity binding, and mandatory cursor/relationship indexes;
- `0036_hosted_query_runtime.sql`: snapshot-keyset query cursors, invocation-backed Obsidian Base state, bounded replay receipts/accounting, and runtime admission control.
- `0037_hosted_admission_fence.sql`: operation-bound cutover/rollback fencing, a durable expiring cutover-owner lease, and the provisional-open expiry lease.

The chronological beta72/beta73 migrations 0035–0059 are development history and are not a production upgrade path. Current beta73 staging must not be promoted or pointed at the rewritten migration set.

## Data and confidentiality invariants

Encrypted exact Markdown is the sole canonical record authority. A full semantic projection derived by `mdbase-rs` is provider-readable and rebuildable. It contains paths, file facts, types, persisted/effective frontmatter, diagnostics, resolution keys, body-derived structural facts, and outgoing relationship occurrences. It does not contain exact Markdown or body prose.

Connect persists the encrypted authority and derived rows transactionally; it does not implement independent parsing or link semantics. PostgreSQL executes only the closed, versioned candidate, ordering, keyset, grouping, and aggregation plans emitted by `mdbase-rs`.

There is one hosted runtime. The final schema has no `legacy | candidate_b` mode, pending activation mode, inline Base cursor form, old execution proofs, or `json-v1` query receipts.

## Active binding

An active binding consists of:

- catalog revision;
- projection format version;
- semantic engine version;
- generation ID; and
- `active_projection_head`.

Those fields are all null or all present. A binding is current only when the generation is complete, integrity-verified, bound to the current resource/catalog/engine contract, its source head is not newer than the bound head, and `active_projection_head` equals the exact collection head.

Ordinary exact writes update exact ciphertext, retained version, head, projection version, relationship state, journal/receipt/outbox, and active projection head in one transaction. Non-record collection sequence changes also advance the active projection head. A semantic catalog change clears the binding and starts a rebuild; the existing active collection remains available through bounded canonical stale/absent fallback while that rebuild runs.

New collections begin in transient `indexing` state and are not returned until their initial generation verifies. Authority imports move `importing → indexing → active`; completion receipts remain resumable and imports cannot be aborted after indexing starts. A crash after generation activation is repaired by the bounded import finalizer.

## Generation state machine

1. Under the collection lock, capture exact head, resource revision, canonical catalog revision, format, and engine into an inactive `building/projection` generation.
2. Claim one short lease with a monotonic fence. Read at most one UUID-keyset batch and enforce row, ciphertext, projection, and deadline limits before decrypting or transferring more data.
3. Persist prepared projections and resolution keys only while the exact revision and generation fence still match. Terminal oversized or malformed semantic state quarantines the generation without poisoning unrelated collections.
4. After a complete prepared-state proof, transition to `building/resolution` and resolve structural occurrences through `mdbase-rs` against the frozen key snapshot.
5. Persist final projections and temporal outgoing edges. Backlinks are indexed inverse queries over resolved target identity.
6. Prove no missing, extra, stale, incomplete, unresolved, or digest-invalid projection, resolution key, or relationship row remains. Atomically bind and mark complete only if source head/resource/catalog still match.
7. If the source changes, abandon and restart from the new authority binding. Normal batch completion releases its lease so another process resumes immediately; crashes recover after lease expiry, with the fence preventing stale commits.

Projection rows are temporal (`valid_from_sequence` inclusive, `valid_to_sequence` exclusive). Exact revision, catalog, format, engine, digest, semantic completeness, and relationship completeness are checked before candidate use. Statement triggers advance the generation integrity epoch after any complete-generation projection, resolution-key, or relationship mutation. The cutover verifier independently reconstructs canonical key and edge fingerprints from the versioned mdbase-rs semantic projection, so missing, extra, or altered derived rows fail closed before admission.

## Physical index policy

The baseline has no general projection GIN, per-field, full-text body, range/order, blind, or automatic property index. It includes only:

- generation work/lease and missing-binding backfill indexes;
- current record/path identity and deterministic snapshot path cursor indexes;
- the measured descending file-mtime cursor index;
- resolution-key identity lookups;
- outgoing, resolved-backlink, and unresolved-target relationship indexes;
- cursor, invocation, and replay-receipt ownership/expiry indexes.

Any additional projection index requires `EXPLAIN (ANALYZE, BUFFERS)` plus write latency, WAL, HOT, rebuild, vacuum, and bloat evidence.

## Operator flow

The provider image contains `mdbase-hosted-projection-indexer`. It uses the same crypto, parser, projection writer, lease, fence, checkpoint, and verification code as runtime recovery.

- `plan`: requires the exact migration ledger and schema, then pages an inventory of collection heads, resource revisions, records, retained versions, ciphertext bytes, and readiness.
- `apply`: starts or resumes the expected head/resource binding and advances only the configured bounded batches per collection.
- `status`: reports current binding, bounded generation progress, and terminal errors.
- `verify`: requires a complete page inventory and proves exact/projected record counts and digests, resolution completeness, and the final binding.
- `cutover`: applies migrations, pages the entire active/indexing inventory, resumes
  each durable generation to completion, and canonically verifies every binding.
  It has explicit wall-time, page, collection, per-collection batch, and total-batch
  ceilings. Reaching any ceiling is a typed non-success result, never partial
  readiness. It is run only as a pre-deploy job after the old provider service is
  terminally suspended, so no source-34 process can race migration or indexing.
  Migrations execute on the exact PostgreSQL session holding the global lock;
  ordinary migration-capable startup serializes behind the same lock. Immediately
  after migration the operator atomically persists its owner token and bounded
  owner lease while admission is closed. Each page and batch rechecks both the
  session lock and durable owner. A same-token recovery renews the lease; a new
  token may claim only an expired owner whose admission is already closed.
  Archived beta69 mutation receipts are converted in at most 100-row pages
  under the same owner checks and shrinking deadline before projection inventory
  begins; no cutover receipt migration uses an unbounded `fetch_all`.

Output is machine-readable JSON with run identity and timestamps but no exact Markdown, body prose, keys, or ciphertext. Repeated processes are idempotent. `verify` never treats a building or partially complete generation as success.

## Authority bulk boundary

Normal reads, queries, validation, and mutations never materialize a collection-wide workspace. Template bootstrap and portable authority import/export use the separately named `AuthorityWorkspace` because `mdbase-rs` must canonically validate a complete portable snapshot. Admission is hard-bounded by the published authority-bulk record, exact-byte, resource-byte, and estimated-plaintext ceilings before complete decryption/materialization. Exceeding a ceiling is the typed `hosted_authority_bulk_budget_exceeded` outcome.

## Production cutover

1. Enter the reviewed external maintenance window and stop new hosted operations on the exact beta69 service set.
2. Run `preflight-hosted-provider-beta69-cutover.sql`. It requires the exact successful 1–34 ledger and absence of every Candidate B object.
3. Reconfirm recovery artifacts, key reader, capacity, and privacy-safe canonical inventory.
4. Terminally suspend the source provider at the service scheduler. The
   candidate operator re-attests the drained source-34 state, then `cutover`
   acquires a PostgreSQL-wide owner-token advisory lock before applying
   migrations 0035–0037 on that same lock-owning session. The one total deadline
   covers key setup, connection, migrations, rebuild and verification. Server-side
   statement deadlines shrink with the remaining budget, and timeout closes the
   cutover database lanes. Before releasing the session lock, the operator
   persists the expiring durable owner and admission fence. Every page and batch
   rechecks both forms of ownership before continuing.
5. Abort on a typed cutover budget result, any unverified collection, a changed
   expected head/resource binding, or an incomplete inventory. Retry resumes the
   durable generation checkpoints while the service remains suspended.
6. Compare canonical tables/inventory with the pre-cutover evidence. Only derived projection/runtime rows and additive active bindings may differ.
7. Deploy the immutable final provider/control/MCP set while external maintenance and durable admission remain closed.
8. Run synthetic and representative exact read/write, query, pagination, link, cancellation, restart, and recovery checks.
9. Open admission with a 30–600 second provisional lease, verify the open
   runtime, and finalize the lease with the same owner token. Every provider
   data and control route fails closed after lease expiry, so a hard-killed
   runner cannot leave an unverified cutover open. Health/readiness remain
   observable. Resume external traffic only after every collection verifies and
   the expected release/recovery status is visible.

Production migration and activation remain prohibited until the final explicit user approval.

## Beta69 code rollback and forward recovery

Schema downgrade is neither required nor permitted. Beta69 uses `ignore_missing` and tolerates the additive final tables/columns.

1. Keep external traffic in maintenance and run `suspend-hosted-query-admission-for-rollback.sql`. Its exclusive advisory transaction lock drains final query pages before persisting the fence.
2. Strongly inventory canonical exact tables.
3. Run `prepare-hosted-provider-beta69-rollback.sql`. It requires the exact successful 1–37 ledger, rejects final-only `indexing` rows, deletes only ephemeral final query cursors/invocations/replay receipts, and abandons only incomplete derived generations. It does not delete or update records, versions, changes, mutation receipts, resources, files, grants, journals, or outbox rows.
4. Deploy the exact beta69 image set. Reopen external maintenance only after beta69 exact reads/writes and consumer smoke checks pass. The final database admission flag is ignored by beta69 and should remain set for the later roll-forward.
5. To roll forward, return to maintenance, deploy the final image, run indexer plan/apply/verify, and prove beta69-era writes caused only stale bindings that rebuild from exact authority.
6. Resume database admission with `resume-hosted-query-admission.sql` only after the final runtime and every collection verify.

Complete projection rows remain for diagnosis and fast roll-forward. Deleting live readable projection rows would not remove values already present in WAL, replicas, snapshots, backups, or forensic copies and is not a confidentiality rollback.

## Evidence

The consolidated schema comparison and intentional differences are recorded in [candidate-b-consolidated-schema-diff.md](candidate-b-consolidated-schema-diff.md). The branch test suite covers beta69 migration replay, atomic bootstrap/import activation, interruption/retry, stale source recovery, digest/integrity failure, snapshot-safe write-through, cursor replay, cancellation, authorization fallback, relationship behavior, and high-cardinality budget paths. Fresh beta69 staging, full rollback/roll-forward, consumer missions, and release-candidate soak remain required before the production gate.
