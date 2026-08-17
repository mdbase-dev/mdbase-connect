# Hosted semantic projection migration

Status: additive schema implemented and locally validated; no existing-data migration authorized

Migration: `crates/connect-hosted-provider/migrations/0035_hosted_semantic_projections.sql`
Activation gate: `crates/connect-hosted-provider/migrations/0036_hosted_execution_model.sql`
Cursor invocation binding: `crates/connect-hosted-provider/migrations/0037_hosted_query_invocations.sql`
Obsidian Base cursor state: `crates/connect-hosted-provider/migrations/0038_hosted_obsidian_base_cursors.sql`
Bounded execution proofs: `crates/connect-hosted-provider/migrations/0045_hosted_query_execution_proofs.sql`
Temporal digest correction: `crates/connect-hosted-provider/migrations/0046_hosted_projection_temporal_digest.sql`
Rollback admission fence: `crates/connect-hosted-provider/migrations/0047_hosted_runtime_rollback_fence.sql`
Verified integrity epoch: `crates/connect-hosted-provider/migrations/0052_projection_integrity_verification.sql`
Snapshot path cursor index: `crates/connect-hosted-provider/migrations/0053_snapshot_path_cursor_index.sql`
Single-write digest binding: `crates/connect-hosted-provider/migrations/0054_projection_digest_single_write.sql`
Snapshot mtime cursor index: `crates/connect-hosted-provider/migrations/0055_snapshot_mtime_cursor_index.sql`
Versioned query-receipt compression: `crates/connect-hosted-provider/migrations/0056_query_receipt_compression.sql`
Immutable receipt ownership: `crates/connect-hosted-provider/migrations/0057_query_receipt_identity_immutability.sql`
Guarded digest binding: `crates/connect-hosted-provider/migrations/0058_projection_digest_write_guard.sql`
Atomic activation intent: `crates/connect-hosted-provider/migrations/0059_hosted_execution_model_activation.sql`

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
Migration 0036 adds an explicit `legacy | candidate_b` execution-model gate with a
`legacy` default. Existing collections therefore keep their recoverable path when
the additive schema and dual-capable binary deploy. Requesting the first explicitly
authorized generation writes a durable
`pending_hosted_execution_model = 'candidate_b'` intent but leaves the collection
on `legacy`. Maintenance recreates missing generations and advances one bounded
fenced batch at a time for active or pending collections. Only the generation's
completion transaction binds the fully resolved snapshot, changes
`hosted_execution_model` to `candidate_b`, and clears the pending intent. A failed,
stale, cancelled, or restarted build therefore never exposes a half-projected
collection and never removes the legacy path.

The internal activation protocol is `candidate-b-activation-v1`. Status returns
only execution/binding state, head, resource revision, the current building
generation, and bounded metadata for the latest terminal generation. Activation
requires the expected head, expected resource revision, and
an exact `activate-candidate-b:<collection>:<head>:<revision>` confirmation. A retry
returns the existing authorized generation instead of superseding it. Advance names
that generation and executes exactly one bounded projection or resolution batch.
The control plane may set
`MDBASE_CONNECT_NEW_HOSTED_EXECUTION_MODEL=candidate_b` for an isolated environment;
the default is `legacy`. In Candidate B mode, a newly created provider collection
must complete this bounded protocol before its control-plane catalogue row is
inserted or returned to a consumer. Completed authority imports use the same gate:
the provider import receipt remains replayable while Connect resumes bounded
activation calls. A request that exhausts its 16 one-batch advances returns an
explicit HTTP 202 `activating` response; the same fenced completion request is
safe to resume while the periodic provider worker also advances it. The
control-plane transfer stays `activating` until the complete Candidate B generation
is visible.

## Physical state

`hosted_provider_collections` gains:

- `active_catalog_revision`;
- `active_projection_format_version`;
- `active_semantic_engine_version`; and
- `active_projection_generation_id`.

Migration 0059 additionally adds nullable `pending_hosted_execution_model`. The
only non-null value is `candidate_b`; it records authorization to rebuild and
survives process restart or source-head races without changing query routing.

They are either all null or all present. Existing encrypted exact records remain
unchanged and authoritative.

`hosted_provider_projection_generations` stores one collection-scoped generation:

- target semantic catalog, projection format, semantic-engine version, and source
  head;
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
- separate 32-byte expected/observed projection digests plus the structural
  digest; and
- an application-enforced 256 KiB projection limit backed by a database check.

Projection history cascades only with the collection, not the current exact-record
row, so a logical snapshot may still query a record deleted after its pinned head.
A rename/swap transaction closes every affected open path before inserting new
versions. A projection digest detects accidental substitution or corruption; it is
not a MAC and never replaces exact authorization or canonical classification.
Migration 0044 adds a nullable observed digest and a row trigger without rewriting
existing projection rows. Migration 0054 later removes the second application
`UPDATE`: a Candidate B writer inserts an all-zero 32-byte expected digest as a
trusted-application marker, and the `BEFORE` trigger replaces that marker with the
database-canonical observed digest in the same tuple version. Migration 0058
requires that marker to arrive through a transaction that explicitly enables the
projection-writer capability. The capability is not a credential or a MAC—an actor
already trusted to issue arbitrary database SQL can still calculate the unkeyed
digest—but it prevents incidental SQL and future generic maintenance paths from
silently blessing changed readable state. Unmarked SQL changes continue to advance
only the observed side and therefore fail closed. A pre-0058 binary is compatible
only before Candidate B activation and before any projection rows exist; the
rollback preflight enforces that boundary.
Every SQL currentness predicate compares those two 32-byte values before candidate
filtering or authorization. Any older row or changed path, type set, file fact,
semantic payload, structural digest, completeness flag, or binding therefore enters
the bounded stale/absent exact fallback. Pre-0044 generations must rebuild; the
migration does not produce projection-table-sized WAL or hold a rewrite lock.

Migration 0046 replaces that envelope with v2, which also binds the exclusive
`valid_to_sequence`. Ordinary write-through closes a row first and then refreshes
its expected digest in the same transaction, so append-only snapshot history stays
valid while an out-of-band temporal-boundary change fails closed. Because a v1 row
cannot prove that boundary, 0046 refuses to run while any prototype projection row
exists. Candidate B is not production-active before this migration: operators must
remove only disposable staging generations, apply 0046, and rebuild them from the
encrypted exact authority. The migration never relabels or bulk-rewrites a weaker
row.

Migration 0052 records `integrity_verified_epoch` separately from the trigger-
advanced generation integrity epoch. A completed rebuild proves the entire
generation before binding both epochs. An ordinary exact/projection/relationship
write advances both only inside its atomic transaction and only when the previous
generation proof was current. Direct or otherwise unverified projection changes
advance `integrity_epoch` alone. The next query then performs the complete
stale/absent/digest scan and either marks that exact epoch verified with a
compare-and-set update or falls back/fails closed. A concurrent change cannot be
blessed because the verification update names the observed epoch.

Migration 0053 adds the mandatory snapshot path cursor btree over collection,
generation, canonical `C`-collated path, record identity, and temporal bounds. It
supports the default deterministic `(path, record_id)` keyset while retaining
closed rows required by an older pinned snapshot. It is an access-model index, not
a general semantic projection index.

Migration 0055 adds the one evidence-backed scalar cursor btree for the Editor's
common descending file-mtime listing, followed by canonical path and record
identity. Ascending mtime and arbitrary frontmatter ordering remain on the
explicitly bounded top-K path; they do not gain unbounded SQL sorts or automatic
property indexes.

The direct page executor preserves those ordered access paths with three local,
transaction-scoped planner controls. Candidate/type/generation parameters use a
custom plan on every page; JIT is disabled because its compilation floor exceeds
the bounded interactive-page budget; and only the direct ordered statement
discourages an explicit sort. Its version-currentness check is a correlated,
indexed existence proof rather than a flattened hash join. PostgreSQL can still
sort if an ordered path is unavailable, but the closed direct-plan admission rule
means that condition is an implementation error rather than an automatic
collection scan. Grouping and bounded top-K statements run with normal sort
planning. Deterministic 100k evidence must show both cursor indexes being used and
must separately report successful pages and typed budget outcomes.

Projection format 3 corrects the closed link-resolution contract so the mandatory
Markdown `.md` path alternative is always present in addition to configured extra
record extensions. A format-2 generation must be rebuilt; it cannot be relabelled,
because extensionless wikilinks may have persisted an incorrect `missing` outcome.

Projection format 4 makes hosted file modification time a required
revision-scoped fact. The authoritative timestamp is the exact record-version
commit time and is copied into both the semantic projection and the indexed
`file_modified_at` column. Format-3 rows may contain a null time, so they must be
rebuilt and cannot be relabelled as format 4. The JSON schema identifier remains v3
because this tightens the binding of an existing nullable field rather than adding
a new projection member.

Projection format 5 establishes the body-prose confidentiality boundary. Body
relationship occurrences retain targets, kinds, anchors, relative-form and
resolution facts but redact labels, destination titles, malformed source tails and
complete Markdown source spelling. Effective computed fields that transitively
read `file.body` are omitted and mark the projection incomplete, forcing bounded
exact fallback. Earlier rows may contain either form of body prose and therefore
must be treated as stale, rebuilt from encrypted authority, and pruned under the
normal retained-generation/backup policy; they cannot be relabelled as format 5.
The semantic JSON schema identifier advances to v4 and the record-structure schema
to v3.

`hosted_provider_record_resolution_keys` stores the complete closed lookup-key set
emitted by mdbase-rs for each record version: exact path plus normalized basename,
configured ID, and title keys. Connect performs exact indexed lookup only; it does
not reproduce link-resolution semantics. Keys carry the full projection currentness
binding and the same inclusive/exclusive validity interval as their projection.

`hosted_provider_record_relationships` stores deterministic outgoing occurrences:

- source record/revision and full semantic binding;
- kind, source field, safe target, normalized target, anchor, and relative flag;
- explicit `resolved | missing | ambiguous | external | unsafe` resolution; and
- resolved target identity/path where available.

Outgoing edges use the same temporal validity interval. Target identity deliberately
has no foreign key: a pinned snapshot can retain references across later deletion,
and unresolved/reference evidence remains queryable until retention pruning. The
semantic engine, not SQL, decides resolution and rewrite behavior.

`hosted_provider_query_cursors` stores a closed mdbase-rs plan, canonical query
digest, replica/scope epoch, semantic generation, logical snapshot head, keyset
boundary, emitted/remaining limits, and idle/hard expiries. Cursors never retain
plaintext, a database connection, or an exported PostgreSQL snapshot. The cursor
also binds its public request kind and digest so direct-query and saved-view tokens
cannot cross surfaces. A query's single exact `this` context may be retained only
as collection-envelope ciphertext under a cursor-specific identity and the normal
exact-byte budget; it is decrypted for one page and dropped with that request.
Each page consumes its presented cursor row transactionally and emits a fresh
single-use cursor when more results remain. Per-replica live cursor counts, release,
and idle/hard expiry bound retained state.

Migration 0045 adds an encrypted v1 execution proof bound by AEAD associated data
to cursor identity, replica, scope epoch, request/plan digest, snapshot head and
record count, scan budget, generation/catalog/format/engine binding, projection
integrity epoch, and the selected execution mode. Projected-exact mode freezes its
total and bounded group summary, so later pages execute one keyset page rather than
repeating candidate-validity, count, and grouping scans. An ordinary append-only
write advances the generation integrity epoch; the next page performs one bounded
snapshot-currentness proof, then rebinds its successor cursor. Corruption or a
missing/stale snapshot projection invalidates the cursor. A default collection scan
is rejected before execution above 100,000 pinned records; the larger fixture
entitlement exists only in debug/test processes.

Every page response has an encrypted request-ID receipt for lost-response replay.
The newest 64 receipts per replica form a sliding window: page 65 evicts the oldest
instead of failing a valid traversal. Per-receipt, replica, collection, account, and
global ciphertext-byte quotas are serialized by an advisory transaction lock.
Migration 0051 makes the encrypted response payload immutable in PostgreSQL. Account
reconciliation may still rebind the receipt's account identifier, but no runtime or
operator path may change its ciphertext footprint without deleting and recreating
the ephemeral receipt through the ordinary admission path.
Migration 0057 also makes the receipt's replica and collection identities immutable.
Those identities determine the transactionally maintained usage-counter keys;
rejecting rebinding prevents a maintenance update from leaving replica or collection
counters attached to the wrong durable receipt. Account identity remains the sole
mutable ownership field because reconciliation moves its counter in the same
transaction.
Migration 0056 adds an explicit response encoding. Legacy and rollback writers keep
the `json-v1` default; Candidate B writers serialize once, enforce the plaintext
receipt ceiling, compress beneficial payloads as `zstd-json-v1`, and then encrypt.
Replay authenticates and decrypts before bounded decompression. This preserves exact
idempotent replay while preventing encrypted, non-TOAST-compressible page bodies
from dominating WAL and grouping latency. A rollback after Candidate B traffic must
first explicitly drain them or wait out the configured one-hour cursor hard expiry
plus one bounded maintenance sweep; the 15-minute idle expiry alone is not a safe
rollback boundary. Before collection activation, production cannot contain the new
encoding.
Background expiry removes no more than 1,000 rows and 256 MiB per maintenance pass.
A retry outside the recent window must restart from a new snapshot if its consumed
cursor is no longer present; recent responses replay the same operation result.

Migration 0038 extends the same cursor state machine with a distinct
`obsidian_base` request kind, a bounded digest-checked mdbase-rs Base plan, an
optional readable semantic context projection, and a pinned operation clock.
Cross-kind replay remains invalid. The Base plan may reveal formulas, property
references, renderer configuration, and ordering/grouping semantics to a database
reader; it never stores exact Markdown or body prose.

## Index inventory

The baseline creates no projection GIN.

- Generation work: partial `(status, lease_expires_at, collection_id,
  generation_id)` for building claims.
- Projection settlement: `(collection_id, generation_id, valid_to_sequence,
  record_id)` for rebuild keysets and completion proof.
- Deterministic temporal path cursor: `(collection_id, generation_id,
  canonical_path COLLATE "C", record_id, valid_from_sequence, valid_to_sequence)`.
- Measured Editor cursor: `(collection_id, generation_id, file_modified_at DESC
  NULLS FIRST, canonical_path COLLATE "C", record_id, valid_from_sequence,
  valid_to_sequence)`.
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
- Base invocation cleanup: `(hard_expires_at, invocation_id)` globally and
  `(collection_id, hard_expires_at, invocation_id)` for per-page/per-collection
  orphan cleanup.

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
   If one prepared or final semantic projection exceeds 256 KiB, atomically mark
   the generation `abandoned` with terminal `projection_record_too_large` evidence.
   Recovery does not retry that authority-head/catalog/engine tuple until the exact
   record or semantic catalog changes.
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

Migration `0039_exact_base_query_cursors.sql` permits a null generation binding
only for Obsidian Base cursors. This lets an exact-fallback cursor pin the temporal
record head, catalog/engine contract, invocation, and keyset when no usable
projection generation exists. Generic queries and canonical Markdown views remain
generation-required. The foreign key continues to bind every non-null generation.

Migration `0040_hosted_base_query_invocations.sql` moves immutable Base plan,
semantic context, and operation-clock state into a separately expiring invocation
row. Rotating single-use cursor rows retain only the keyset and an invocation
foreign key, so later pages do not rewrite the same large JSON state. The migration
backfills live inline Base cursors and keeps the inline form valid for old writers
during rollback. A binary rolled back before 0040 cannot consume already-migrated
invocation-backed cursors; those cursors have a configured one-hour hard lifetime and may
be explicitly released or allowed to expire before rollback. A rollback to any
provider binary predating 0040 **must** run the fail-closed executable preflight
before changing the binary:

```sh
psql "$DATABASE_URL" --single-transaction \
  --file deploy/postgres/preflight-hosted-provider-pre-0040-rollback.sql
```

The command exits non-zero while any live invocation-backed Base cursor remains.
Clients should send the ordinary `release_cursor` query control, or operators must
wait for the one-hour hard lifetime and bounded maintenance cleanup; deleting live rows
with ad-hoc SQL is not an accepted rollback step. Cleanup removes an invocation
after its last cursor is consumed/released and removes expired orphans during
compaction and projection pruning.

Migration 0043 builds its global receipt-expiry index in the same quiescent schema
job that creates the receipt table. The migration has a five-second lock timeout
and 30-second statement timeout. Production preflight must prove the provider is
drained and the table is new/empty; an unexpected populated deployment fails for
operator review instead of waiting indefinitely on a blocking `CREATE INDEX`.

Migrations 0053 and 0055 are non-transactional `CREATE INDEX CONCURRENTLY`
steps. Provider startup dedicates one migration connection, applies a five-second
lock timeout and 30-minute statement timeout, and concurrently removes only the
two allowlisted invalid indexes left by an interrupted prior build before retrying.
The candidate image also contains PostgreSQL client tooling and every reviewed
preflight under `/usr/local/share/mdbase-connect/postgres`; managed rollout invokes
those exact files as waited one-off jobs rather than relying on an operator's
workstation or an unversioned SQL copy.

Rollback to a provider predating migration 0056 additionally requires query
admission to remain fenced and every `zstd-json-v1` query-page receipt to be
released or drained after its one-hour hard lifetime. The image-bundled
pre-0056 gate runs before the existing pre-0044 and pre-0040 compatibility
checks, so lost-response replay is never handed to a binary that cannot decode
its durable receipt.

Rollback to a provider predating migration 0058 additionally requires zero
Candidate B collections and zero projection rows. The image-bundled pre-0058 gate
runs while query admission is fenced. Once readable projection state exists,
rollback must use a digest-guard-aware image; dropping projection rows to force an
older binary through the gate is not an accepted recovery action.

Ordinary writes after activation always generate against the active catalog. They
close prior temporal rows and commit ciphertext, revision, current projection
binding, relationship state, versions/changes, quotas, journal settlement, receipt,
and outbox atomically. An unchanged structural digest and unchanged resolution-key
set preserve outgoing edge rows. Path/ID/title creation, change, or deletion
revalidates affected resolved, missing, and ambiguous incoming sources under
explicit record and plaintext-byte budgets; exceeding either is a typed failure and
rolls back the exact write.

Semantic catalog mutations atomically clear the active binding, abandon unfinished
rebuilds, and expire catalog-bound query cursors. The semantic revision is a
canonical digest of exact configuration, resolved types, and record contracts.
View-only resource mutations advance the encrypted resource revision but retain the
active projection generation because they cannot change a record projection. Exact
authority remains available while a new semantic generation is built.

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

Before production activation, rollback is a code rollback; all new rows remain
derived and no canonical state changed. A pre-0059 binary ignores a pending
activation and continues routing that collection through `legacy`; it does not
recover the intent, and a later 0059-aware deployment resumes it. During an isolated activated staging
test, an operator may invalidate query cursors and atomically null all four
collection binding fields to return traffic to the encrypted exact path while
retaining generation-scoped projection rows for diagnosis.

Migration 0047 closes rollback/preflight races with a durable query-admission flag.
Every query page holds the shared advisory transaction lock; the suspension script
takes the exclusive lock, waits for in-flight pages, and persists the flag. New
pages then return typed `hosted_query_admission_suspended`, while `release_cursor`
remains available for draining. The rollback sequence is:

1. run `deploy/postgres/suspend-hosted-query-admission-for-rollback.sql`;
2. drain or release live cursors and wait for active hosted-query sessions to end;
3. before a pre-0058 binary, run
   `preflight-hosted-provider-pre-0058-rollback.sql`; it succeeds only when no
   Candidate B collection or projection row exists;
4. before a pre-0056 binary, additionally drain compressed receipts and run
   `preflight-hosted-provider-pre-0056-rollback.sql`;
5. before a pre-0044 binary, return every activated collection to encrypted-exact
   legacy execution with
   `deactivate-candidate-b-collection-for-rollback.sql`, then run
   `preflight-hosted-provider-pre-0044-rollback.sql`;
6. before a pre-0040 binary, additionally run
   `preflight-hosted-provider-pre-0040-rollback.sql`;
7. switch and verify the selected binary; then run
   `resume-hosted-query-admission.sql` only when it is safe to accept traffic.

The pre-0044 gate is mandatory because that older writer places a semantic digest
where the row-integrity digest is required; it must never write an activated v2
generation. The durable flag remains set if any preflight fails, so a failed
rollback cannot reopen the admission race. Deployment automation must treat these
scripts as required gates, not advisory diagnostics.

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
