# Projection, rebuild, snapshot, recovery, and authorization protocol

Status: frozen benchmark contract for proposed ADR 0011. This is not a selected
production design.

## Versioned state

Candidate A has no persisted semantic projection. Candidates B and C use these
bindings:

- collection: `active_catalog_revision`,
  `active_projection_format_version`, and `active_generation_id`;
- generation: `generation_id`, `target_catalog_revision`,
  `projection_format_version`, status, checkpoint, lease, and timestamps; and
- record projection: `record_id`, `record_revision`, `catalog_revision`,
  `projection_format_version`, `generation_id`, readable path/type/file envelope,
  semantic JSON payload, and payload digest.

A projection is current only when all five predicates hold:

```text
projection.record_revision = record.record_revision
projection.catalog_revision = pinned.active_catalog_revision
projection.projection_format_version = pinned.active_projection_format_version
projection.generation_id = pinned.active_generation_id
generation.status IN (building, complete)
```

`complete` is an optimization statement, not an authorization grant. A query may
use current rows from a building generation because currentness is per record.

The readable projection envelope (`path`, `types`, file size/mtime) is stored in
unindexed columns. `semantic_projection` contains persisted/effective frontmatter,
relationships, and diagnostics. The optional GIN covers only that JSONB column.
Thus a body-only update advances record revision, binding, file size/mtime, and
digest while leaving semantic JSON unchanged. Candidate A has no projection row.

Production persists an expected `projection_digest` and a separately observed
`projection_observed_digest`. The observed value is the SHA-256 of UTF-8
PostgreSQL canonical `jsonb_build_array(...)::text` for:

```text
["mdbase/hosted-projection-row/v1", collection_id, record_id,
 record_sequence, valid_from_sequence, record_revision, catalog_revision,
 projection_format_version, semantic_engine_version, generation_id,
 canonical_path, matched_types, file_size_bytes, file_modified_at,
 semantic_complete, resolution_complete, semantic_projection,
 hex(structural_digest), projection_bytes]
```

The database trigger recomputes only the observed side whenever a row changes; the
application sets the expected side only after canonical persistence in the same
transaction. Candidate SQL compares the two stored 32-byte values, avoiding a
per-query JSON/TOAST rehash. It is an unkeyed integrity/substitution check, not a
confidentiality or authenticity boundary. Tests swap valid JSON, frontmatter,
paths, types, and whole payloads across records and require bounded canonical
fallback, including authorization widening and narrowing under a contract scope.
Rows written before this envelope have a null observed value and remain invalid
until rebuilt rather than being rewritten by the migration.

## Resource/catalog transition

1. Begin a short transaction and lock the collection semantic-state row.
2. Persist the new exact resource bundle in the candidate's confidentiality form.
3. Compile it through mdbase-rs. Invalid resources abort the transaction.
4. Allocate a new generation with status `building`, a null checkpoint, and no
   lease.
5. Atomically update the active catalog revision, format version, and generation.
6. Commit. Existing projections immediately become stale because their bindings no
   longer match. They are never relabelled current.
7. Enqueue the generation identifier for rebuild. Queue loss is safe because a
   periodic scan finds active building generations without a live lease.

Candidate A performs steps 1-3 and advances its catalog revision without opening a
projection generation.

## Ordinary record write

1. Locate the target by authoritative stable ID or canonical path identity. Do not
   filter by persisted type data.
2. Pin the collection catalog, projection version/generation, grant contract
   digest, grant/scope epoch, quota state, and current record revision.
3. Parse/classify the proposed exact Markdown through mdbase-rs. For B/C, generate
   the projection from the same canonical result.
4. Prepare encrypted or readable physical values outside the commit transaction.
5. Enter the existing mutation-journal transaction and revalidate record revision,
   catalog revision, active generation/version, grant/scope epoch, destination,
   and quota.
6. Persist the exact record, retained version/change, and current projection in the
   same transaction. A catalog/generation mismatch produces a typed retry/conflict;
   it never commits a projection labelled with semantics that were not used.
7. Complete the journal receipt and outbox using the existing fencing rules.

Body-only writes use narrow SQL updates: they do not assign an unchanged path
identity or semantic JSON payload, but they atomically advance the projection's
record-revision binding, file facts, and digest. HOT is measured, never assumed.

## Rebuild worker

1. Claim a generation only when `status = 'building'` by compare-and-set from an
   absent/expired lease to a new `lease_owner` and `lease_expires_at`. Renew and
   release require the same building status, owner, and unexpired lease. Complete or
   abandoned generations cannot carry a lease.
2. Read records by PostgreSQL's ascending UUID order on `(collection_id,
   record_id)`, strictly after the UUID value in `checkpoint_record_id`, in the
   frozen batch/byte budgets. Read an exact record and its revision.
3. Compute the projection through the pinned mdbase-rs catalogue outside a write
   transaction.
4. In a short transaction, lock the record row `FOR KEY SHARE`, verify its revision
   still equals the computed revision, verify the generation remains active and
   building, then upsert the projection bindings and payload. If any predicate
   changed, skip/retry; never overwrite newer projection state.
5. Advance the checkpoint to the greatest UUID value only after all earlier records
   in that keyset batch are either written current or proven concurrently changed.
   Checkpoint and lease renewal commit together.
6. After the terminal keyset page, lock collection and generation rows. Mark the
   generation `complete` only when it is still active and a `NOT EXISTS` proof finds
   no live record with an absent or non-current projection.

Deleting the record named by a checkpoint does not invalidate the UUID value.
Records inserted before the checkpoint already receive a current projection in
their write transaction; records inserted after it are visited or already current.

Crash before step 4 loses only computed work. Crash after projection commit but
before checkpoint causes idempotent recomputation. Crash after checkpoint is safe
because every preceding row was settled. An expired lease is reclaimable. A
superseded generation becomes `abandoned`; its rows are removable only after no
active repeatable-read snapshot can reference it.

Each claim increments `attempt_count`. A failed attempt records a bounded
`last_error_code` and timestamp without changing the generation to complete.
Periodic discovery intentionally has no benchmark control-plane index; its scan
cost is measured separately so it cannot be hidden as a semantic index.

## Query snapshot and completeness

Every benchmark query uses one `REPEATABLE READ, READ ONLY` transaction and pins
collection semantic state before candidate selection.

- Candidate A scans the bounded exact-record source and canonically evaluates every
  scanned record.
- Candidates B/C select the union of (a) current projections whose closed candidate
  predicate matches and (b) every record whose projection is absent or stale.
- Candidate predicates are supersets. Canonical residual evaluation decides final
  membership whenever the projection is insufficient or the workload contract
  requires exact/body facts.
- A query that cannot finish within the unchanged scan, byte, operator, result,
  snapshot, or deadline budget returns the named typed budget outcome atomically.
  It does not return a partial successful page.

Cancellation closes the result stream and transaction, releases its pool permit,
drops decrypted buffers, and is measured against the existing 5-second cleanup
bound.

## Authorization state machine

Authorization and query completeness are separate checks.

1. Authenticate the replica and pin its grant ID, scope epoch, allowed operations,
   allowed types, contract digest, and the collection/catalog snapshot.
2. Locate a point/mutation target by stable ID or authoritative path identity before
   applying type scope.
3. A projection may classify authorization scope only when every currentness
   predicate above matches the pinned snapshot and its digest verifies.
4. For Candidate A, or for any stale, absent, ambiguous, or unverifiable B/C
   projection, load the exact record and classify it through mdbase-rs.
5. If exact loading, parsing, catalogue compilation, or canonical classification
   cannot complete, authorization-sensitive read and mutation operations fail
   closed with a typed authorization/classification error.
6. Contract projection uses the contract digest pinned with the grant. Digest or
   catalogue mismatch fails closed; it is not repaired from an unversioned row.
7. Mutations revalidate record revision, catalog revision, projection generation,
   grant/scope epoch, destination uniqueness, and quota inside the journal commit.

The existing unversioned `hosted_provider_records.types` column is never an
authorization authority in the prototypes. Tests must cover stale narrowing and
widening, resource change during read/write, rebuild/write races, revoked scope,
corrupt projection digests, restart, and lease takeover.

## Required failure evidence

The benchmark must inject and record:

- process exit before/after projection write and before/after checkpoint;
- expired and stolen rebuild leases;
- concurrent record revision CAS loss;
- catalogue supersession during rebuild and mutation preparation;
- stale/missing/corrupt projection rows;
- grant/scope revocation during a query and mutation;
- cancellation during scan, residual evaluation, and rebuild; and
- completion attempted while one stale live record remains.

Every case records final exact revision, projection bindings, generation state,
journal outcome where applicable, and whether access failed closed.
