# Hosted semantic projection migration

Status: additive schema drafted; isolated validation only; no existing-data migration authorized

Migration: `crates/connect-hosted-provider/migrations/0035_hosted_semantic_projections.sql`

## Compatibility strategy

Migration 0035 is additive. Existing collection rows receive four nullable active
projection fields and remain unactivated when all four are null. No record is read,
decrypted, projected, rewritten, or deleted by the migration itself. Older provider
binaries tolerate the newer additive schema through the existing ignore-missing
migration policy.

Activation is a later per-collection transaction, not a schema side effect. A
building generation is not active: the previous complete generation remains bound
while an immutable source-head snapshot is prepared and resolved. The new binding
is installed only if the collection head and catalog still equal that source
snapshot at completion. Otherwise the generation is abandoned and retried.

## Physical state

`hosted_provider_collections` gains:

- `active_catalog_revision`;
- `active_projection_format_version`;
- `active_semantic_engine_version`; and
- `active_projection_generation_id`.

They are either all null or all present. Existing encrypted exact records remain
unchanged and authoritative.

`hosted_provider_projection_generations` stores one collection-scoped generation:

- target catalog, projection format, semantic-engine version, and source head;
- `projection | resolution` phase and `building | complete | abandoned` status;
- UUID keyset checkpoint plus separate projected/resolved counts;
- lease owner/expiry plus a monotonic fencing generation;
- bounded non-content error code and lifecycle timestamps.

Every lease renewal, checkpoint, projection write, completion, and abandonment must
CAS collection, generation, status, owner, unexpired lease, and fencing generation.
Completion additionally proves transactionally that no source-head record is
absent, extra, stale, or unresolved, then CASes the current collection head and
catalog before activation.

`hosted_provider_record_projections` stores temporal projection versions per
generation and record. `valid_from_sequence` is inclusive and
`valid_to_sequence` is exclusive; `record_sequence` separately binds the exact
record revision. This distinction permits relationship-only re-resolution without
inventing a new exact record version. Generation-scoped partial unique indexes
permit one open version per record and canonical path:

- exact record revision and full catalog/format/engine/generation binding;
- readable canonical path, matched types, and selected file facts;
- completeness flag, semantic JSON object, and exact serialized-byte count;
- 32-byte projection and structural digests; and
- an application-enforced 256 KiB projection limit backed by a database check.

Projection history cascades only with the collection, not the current exact-record
row, so a logical snapshot may still query a record deleted after its pinned head.
A rename/swap transaction closes every affected open path before inserting new
versions. A projection digest detects accidental substitution or corruption; it is
not a MAC and never replaces exact authorization or canonical classification.

`hosted_provider_record_resolution_keys` stores the complete closed lookup-key set
emitted by mdbase-rs for each record version: exact path plus normalized basename,
configured ID, and title keys. Connect performs exact indexed lookup only; it does
not reproduce link-resolution semantics. Keys carry the full projection currentness
binding and the same inclusive/exclusive validity interval as their projection.

`hosted_provider_record_relationships` stores deterministic outgoing occurrences:

- source record/revision and full semantic binding;
- kind, source field, raw and normalized target, alias, anchor, and relative flag;
- explicit `resolved | missing | ambiguous | external | unsafe` resolution; and
- resolved target identity/path where available.

Outgoing edges use the same temporal validity interval. Target identity deliberately
has no foreign key: a pinned snapshot can retain references across later deletion,
and unresolved/reference evidence remains queryable until retention pruning. The
semantic engine, not SQL, decides resolution and rewrite behavior.

`hosted_provider_query_cursors` stores a closed mdbase-rs plan, canonical query
digest, replica/scope epoch, semantic generation, logical snapshot head, keyset
boundary, emitted/remaining limits, and idle/hard expiries. Cursors never retain
ciphertext, plaintext, a database connection, or an exported PostgreSQL snapshot.
Each page consumes its presented cursor row transactionally and emits a fresh
single-use cursor when more results remain. Release and expiry delete the row.

## Index inventory

The baseline creates no projection GIN.

- Generation work: partial `(status, lease_expires_at, collection_id,
  generation_id)` for building claims.
- Projection settlement: `(collection_id, generation_id, valid_to_sequence,
  record_id)` for rebuild keysets and completion proof.
- Deterministic temporal path cursor: `(collection_id, generation_id,
  canonical_path COLLATE "C", valid_from_sequence, valid_to_sequence, record_id)`.
- Link identity lookup: `(collection_id, generation_id, key_kind, lookup_key COLLATE "C",
  valid_from_sequence, valid_to_sequence, record_id)` over mdbase-rs-emitted
  path/basename/ID/title keys.
- Outgoing edge lookup: the relationship primary key begins with collection and
  source record.
- Backlinks: partial `(collection_id, generation_id, target_record_id, relationship_kind,
  source_record_id)` for resolved targets.
- Re-resolution: partial `(collection_id, generation_id, normalized_target COLLATE "C",
  source_record_id)` for missing or ambiguous targets.
- Cursor expiry and ownership: `(expires_at, cursor_id)` and
  `(replica_id, collection_id, cursor_id)`.

Any additional index requires measured plan benefit and write/WAL/HOT/rebuild/
vacuum/bloat evidence.

## Activation and rebuild

1. Deploy additive schema and code capable of reading a null binding.
2. Compile the active exact resource snapshot through mdbase-rs.
3. Create an inactive building generation under the collection lock while leaving
   the prior complete generation active.
4. In the `projection` phase, read the latest encrypted exact version at or before
   the immutable source head by UUID keyset. Bound every short transaction by both
   row count and ciphertext bytes. Persist prepared facts and resolution keys only
   when exact version, generation, unexpired lease fence, and catalog still match.
5. After a transactional `NOT EXISTS` proof for prepared projections and keys,
   switch to `resolution`, reset the UUID checkpoint, and resolve every structural
   occurrence against the frozen key snapshot through mdbase-rs.
6. Persist final projections and temporal outgoing edges under the same CAS. Settle
   a checkpoint only after every earlier record is complete or has a durable retry
   outcome.
7. After `NOT EXISTS` proofs for missing, extra, stale, unresolved, or incorrectly
   bound snapshot projections, activate and mark complete only if current head and
   catalog still equal the generation source. A racing write makes the generation
   abandoned rather than partially current.
8. Query current projection matches unioned with stale or absent exact records
   throughout building and after completion; canonical fallback remains bounded and
   fail-closed for authorization.

Ordinary writes after activation always generate against the active catalog. They
close prior temporal rows and commit ciphertext, revision, current projection
binding, relationship state, versions/changes, quotas, journal settlement, receipt,
and outbox atomically. An unchanged structural digest and unchanged resolution-key
set preserve outgoing edge rows. Path/ID/title creation, change, or deletion
revalidates affected resolved, missing, and ambiguous incoming sources under
explicit record and plaintext-byte budgets; exceeding either is a typed failure and
rolls back the exact write.

Catalog mutations atomically clear the active binding, abandon unfinished rebuilds,
and expire catalog-bound query cursors. Exact authority remains available while a
new generation is built.

## Cursor and retention state machines

Opening a cursor validates the canonical query, captures the current collection
head and complete semantic binding, inserts one cursor row, and returns the first
page plus a random opaque cursor ID. A page request locks that row, rechecks replica,
scope epoch, plan digest, expiry, and semantic binding, evaluates only rows valid at
the pinned head, deletes the presented row, and either commits a successor cursor or
finishes. Any mismatch fails closed without advancing the cursor. Explicit release,
idle expiry, hard expiry, replica revocation, or collection deletion removes it.

Projection/key/edge history cannot be pruned while a live cursor or another retained
authority snapshot can address its sequence. The prune watermark is therefore the
minimum of change retention, live cursor heads, and other snapshot leases. A crash
before page commit leaves the old single-use cursor usable; a crash after commit
leaves only the successor returned by the committed response/retry receipt path.

## Code rollback

Before production activation, rollback is simply the previous binary; all new rows
remain unused and no canonical state changed. During an isolated activated staging
test, an operator may invalidate query cursors and atomically null all four
collection binding fields to return traffic to the encrypted exact path while
retaining generation-scoped projection rows for diagnosis.

Dropping projection rows or schema is unnecessary for code rollback and should not
be coupled to it. Provider-readable projection values may already exist in database
pages, WAL, replicas, snapshots, backups, and forensic copies; deleting live rows
does not restore their previous confidentiality. Retention/deletion procedures must
state that distinction.

## Production gate

Do not activate, backfill, or migrate an existing beta/production collection until
the final user approval. The production proposal must name the population cohorts,
rate and capacity limits, pause/abort controls, observability, backup/replica
retention effect, rollback operator, incident procedure, and verification queries.
