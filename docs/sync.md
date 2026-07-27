# Hosted collections and sync

Status: production provider, filesystem mirrors, and authority transfer in both
directions are implemented for private preview. Writable initialization can
also import existing Markdown.

## Purpose

Sync gives a hosted mdbase collection offline application caches and optional
local Markdown mirrors. It belongs to Connect because it coordinates providers,
devices, authorization, and delivery. mdbase continues to define collection and
record behavior.

The first implementation has one authoritative provider for each collection.
mdbase cloud is the authority for a hosted collection. An authorized application
may keep a scoped offline cache, and Connect may materialize a local filesystem
mirror. Both replicas converge through the same versioned replication protocol.

This produces a small user-facing storage model:

- **On this device** creates a standalone local collection.
- **mdbase cloud** creates an account-backed collection with automatic offline
  caching.
- **Mirror to this computer** is an optional property of a cloud collection.

An application uses the same mdbase operations whether the provider is local,
hosted by mdbase cloud, or self-hosted. Provider and replication details stay
outside ordinary application workflows.

## Implemented vertical slice

The repository now contains a provider-neutral sync protocol and a complete
reference path through a real HTTP server:

- shared TypeScript types and a JSON Schema for sessions, pinned snapshots,
  versioned collection resources, scoped change pages, conditional mutations,
  conflicts, and durable receipts;
- an executable authority state machine with stable record IDs, ordered
  revisions, projection by type scope, scope epochs, cursor compaction,
  idempotent retries, and revocation;
- a normalized Rust/PostgreSQL authority with encrypted canonical payloads,
  keyed record-path lookup, quotas, pinned snapshot leases, compactable history,
  and durable idempotency receipts;
- replica registration and hashed bearer credentials on the Connect server;
- direct hosted OAuth capabilities in the browser SDK, without routing record
  payloads through the control plane;
- a durable-store abstraction with memory and IndexedDB implementations, plus
  an offline client for optimistic create, update, rename, and delete;
- contract discovery from each hosted sync session, a generic offline replica,
  and receive-only or writable Markdown directory mirrors with atomic writes,
  durable journals, and explicit conflict resolution;
- hosted collection and mirror controls in the Electron app, including folder
  selection, background sync state, conflict decisions, and revocation without
  a command-line onboarding step;
- a browser/mobile-safe mirror state machine with injected filesystem,
  durable-state, lease, hashing, clock, and identity adapters; the Node entry
  point is now a compatibility adapter around that same core.

The network end-to-end test creates a hosted collection, queues a record
offline, synchronizes two clients, materializes Markdown, returns a stale-write
conflict, recovers an expired cursor without losing pending work, and enforces
replica revocation and token-renewal denial.

The TypeScript authority remains a deterministic protocol test double. The
production route uses `mdbase-connect-hosted-provider`, and hosted validation,
matching, queries, lifecycle behavior, and reference rewrites run through
`mdbase-rs`. A production operator must provide PostgreSQL point-in-time
recovery or equivalent encrypted backups; a restore drill and long-retention
logical-export procedure remain operational launch gates.

## Design commitments

1. **One collection has one write authority.** The authority orders mutations,
   assigns revisions, and publishes the change sequence.
2. **Record identity survives path changes.** Paths remain user-facing and
   mutable; replication uses an immutable record ID.
3. **Replicas converge from durable state.** Initial snapshots, ordered changes,
   tombstones, and reset behavior are part of the protocol.
4. **Every mutation is conditional and replay-safe.** A base revision prevents
   lost updates, and a mutation ID makes retries idempotent.
5. **Replication preserves authorization scope.** A replica receives only the
   records and schemas covered by its grant.
6. **mdbase semantics have one production implementation.** The production
   hosted provider uses `mdbase-rs`; the TypeScript authority is limited to an
   executable replication model and application-neutral test fixtures.
7. **Pending local work is durable.** A disposable cache can be rebuilt from the
   authority, while its queued offline mutations survive process and device
   restarts.

## Authority and replica roles

The hosted path has four roles:

```text
application ── mdbase operations ──> hosted provider ──> authoritative store
     │                                      │
     └── offline application cache <── sync ┤
                                            └── sync ──> Connect filesystem mirror
```

The Connect control plane continues to own accounts, app identity, grants,
tokens, and routing. A hosted provider owns collection payloads and invokes
`mdbase-rs` for collection behavior. Replicas authenticate through Connect and
hold an exact collection, access mode, and contract scope.

Two replica forms serve different purposes:

| Replica | Local representation | Typical scope | Purpose |
| --- | --- | --- | --- |
| Application cache | App-owned database | One or more domain contracts | Fast startup and offline application use |
| Filesystem mirror | mdbase directory and replica metadata | User-selected full collection or contracts | Local Markdown access and desktop tooling |

An application cache is a projection of a collection. It does not need to be a
complete mdbase directory. A filesystem mirror materializes Markdown documents
and, for a full-collection mirror, the collection configuration and type files
needed by local tools.

The replication protocol is provider-neutral. After the cloud-authoritative
path is reliable, a local connector can implement the authority side for a
PC-owned collection. Mobile applications would then use the same offline cache
and sync state, with synchronization resuming whenever that connector is online.

## Hosted provider boundary

The production hosted provider is a Rust service built around `mdbase-rs`. The
control plane sends authorized operations to the provider and receives the
canonical mdbase operation envelope. This keeps hosted and filesystem-backed
collections behaviorally aligned.

The durable design introduces a storage boundary beneath the mdbase engine:

- `FilesystemRecordStore` retains the current local implementation.
- `PostgresRecordStore` supplies hosted records, collection resources,
  conditional writes, and transactions.
- the validation, matching, query, link, and operation layers consume the same
  record-store interface.

The initial hosted store can keep canonical Markdown documents as PostgreSQL
text alongside indexed metadata. This gives record mutation and change-log
publication one database transaction. Object storage becomes useful for large
attachments and old versions later; it is unnecessary for ordinary Markdown in
the first service.

The provider, rather than the control plane, stores:

- canonical Markdown documents;
- collection-relative paths and stable record IDs;
- config and type resources;
- current opaque revisions;
- the ordered replication log;
- retained record versions and tombstones;
- idempotent mutation receipts.

## Creating and moving collections

A new cloud collection is created through the application after sign-in. The
provider installs its config and initial type resources before issuing the
first empty snapshot. An application can provision its required contract types
as part of the authorization flow.

Moving an existing local collection to cloud authority is an explicit cutover:

1. Connect reserves the same collection ID at the target and issues a
   transfer-scoped, short-lived import capability.
2. While the local collection remains authoritative, the agent uploads its
   config, types, Markdown documents, stable record IDs, and revisions in
   resumable pages.
3. The agent fences local mutations, captures a final snapshot under the local
   authority gate, and replaces any staged pages that changed during upload.
4. The provider validates the complete canonical snapshot through `mdbase-rs`
   and marks it ready without making it authoritative.
5. The control plane durably records the exact final snapshot and enters
   `activating` before asking the provider to activate the next authority epoch.
6. The control plane atomically retires the local authority, activates the
   hosted metadata, and revokes old local grants. The original folder becomes a
   mirror of the same collection.

Cancellation or expiry before activation leaves the local collection
authoritative. Once activation starts, retries must use the exact persisted
snapshot identity; Connect never guesses which authority won or reopens the
source after an outcome-uncertain provider response. A collection transferred
back to local can later reuse its retired hosted identity for another round
trip.

Moving back to local authority is implemented as an explicit, browser-confirmed
handoff from a full writable mirror:

1. `mdbase-mirror promote <directory>` synchronizes the mirror and creates a
   short-lived transfer request using its renewal credential.
2. The owner reviews the destination folder and consequences in the Connect
   portal. Approval freezes hosted writes at a final sequence and assigns the
   next authority epoch.
3. Only the promotion mirror may continue reading while frozen. It pulls through
   the final sequence and proves an exact manifest of collection resources and
   record revisions. Unmanaged Markdown, queued writes, or conflicts stop the
   transfer before cutover.
4. The CLI gives the directory the hosted collection's stable ID and registers
   it with the local agent as a disabled candidate.
5. After both the authority proof and local registration exist, the control plane
   atomically activates the local collection in the new epoch, retires the
   hosted authority, and revokes old application grants, tokens, and replicas.

The command is resumable after local materialization. Cancellation or expiry
before completion restores hosted writes. The hosted copy remains retained as a
retired recovery copy until the owner explicitly deletes it, but it cannot
resume writing in the old epoch. Applications must authorize the new local
authority explicitly. This is a product action, not a background merge between
two writers.

## Replication data model

### Collection

A hosted collection has a stable ID, provider ID, owner, mdbase spec version,
current sequence, and collection-resource revision. The provider allocates one
monotonically increasing sequence per collection.

### Record

Each record has:

- `record_id`: an immutable UUIDv7 generated by its first writer;
- `path`: the current collection-relative path;
- `revision`: the opaque revision of the current canonical document;
- `document`: the canonical Markdown source;
- matched types and contract metadata needed for scoped projection;
- deletion state when the record is a retained tombstone.

The replication ID stays in provider and device-local replica metadata. The
reference filesystem mirror stores its path mapping, cursor, pending mutations,
and conflicts in the operating system's application-state directory, leaving
the mirrored directory portable and ordinary Markdown frontmatter unchanged.
Copying an unmanaged file into a writable mirror creates a new record identity.

### Replica

A replica registration records:

- `replica_id` and human-readable device/application name;
- collection ID;
- read-only or read-write mode;
- approved contract scope;
- scope epoch;
- last acknowledged sequence and last-seen time;
- revocation state.

Changing a replica's scope creates a new epoch and a fresh snapshot. A cursor
from an earlier scope never acquires visibility into newly authorized records.

### Change

The provider records a compact authoritative change for every committed state
transition. A scoped replication session projects those changes into two record
events:

- `put`: the record is visible after the change;
- `remove`: the record was visible and is now deleted or outside the scope.

A `put` carries the stable ID, path, revision, types, and complete record
snapshot. A `remove` carries the stable ID, previous path, and tombstone
revision. Renames appear as a `put` for an existing ID at a new path; this lets
every replica converge without reproducing filesystem rename heuristics.

The provider retains versioned snapshots referenced by changes for a bounded
history window. Current records live independently of that window. Compaction
removes expired change history and obsolete versions while preserving live
records, active tombstones, and mutation receipts for their configured
retention periods.

The existing Connect `changes` operation remains a content-free invalidation
feed for ordinary connected applications. The replication feed is a separate,
content-bearing capability available only to an approved replica. Applications
without an offline cache can continue to use `changes` without receiving record
snapshots in the event journal.

### Mutation

An offline mutation contains:

- `mutation_id`: a client-generated UUID used as an idempotency key;
- `replica_id` and scope epoch;
- operation and canonical mdbase input;
- `record_id` for an existing record or a client-generated ID for create;
- `base_revision` for update, rename, and delete;
- creation time and optional causal predecessor within the local queue.

The authority stores the result for each mutation ID. Repeating a request
returns the original result and cannot apply the write twice.

## Initial snapshot

Initial synchronization establishes a consistent checkpoint:

1. The client opens a sync session for an approved replica.
2. The provider returns its scope epoch and a snapshot descriptor pinned to
   sequence `S`, together with the current versioned type and contract
   resources for that scope.
3. The client downloads relevant collection metadata, schemas, and paginated
   record snapshots as they existed at `S`.
4. The client installs the snapshot atomically and stores cursor `S`.
5. The client requests changes after `S` and enters the normal pull loop.

Page tokens belong to one snapshot and expire with it. A restarted download can
resume while the snapshot remains available. A completed snapshot always has a
single sequence boundary, even while newer writes continue at the authority.

Application caches receive normalized records and contract-relevant schemas.
Full filesystem mirrors receive the raw collection configuration, type files,
and canonical Markdown documents.

## Pulling changes

The pull endpoint returns ordered pages after a cursor. Each page includes the
scope epoch, events, next cursor, current head sequence, and `has_more`.

The replica applies a page transactionally:

1. write every `put` by stable ID;
2. remove every tombstoned or scope-departed ID;
3. update schema resources included in the page;
4. commit the new local cursor;
5. acknowledge the cursor asynchronously.

Applying the same page again is safe. A `put` replaces the known state for that
record and a `remove` succeeds when the local record is already absent.

Scope transitions use both sides of the authoritative change. A record entering
scope produces `put`; a record leaving scope produces `remove`; a record outside
scope before and after produces no event. This is the replication equivalent of
the connector's current `types` and `previous_types` enforcement.

## Pushing offline mutations

Read-write replicas maintain a durable ordered mutation queue. They may upload
several independent records together, while preserving order for mutations to
the same record.

The provider processes each mutation through the same policy and mdbase
operation path used online. A successful transaction updates the canonical
record, assigns its new revision, appends the collection change, and stores the
mutation receipt atomically.

Scope is checked again when the authority applies the mutation. A queued write
that has lost permission receives a stable rejected receipt, and the next pull
removes any record that has left the replica's projection.

Applications submit logical operations such as create, update, rename, and
delete. A writable filesystem mirror also needs a provider-internal
`replace_document` mutation for exact Markdown edits. That mutation parses and
validates the complete document through `mdbase-rs`, uses revision compare and
swap, and preserves the submitted Markdown source when accepted.

## Conflicts

Revision mismatch produces a structured conflict containing:

- record ID and current path;
- submitted mutation and base revision;
- current authoritative revision and record snapshot;
- the local queued state needed by the application to resolve it.

The first implementation keeps conflicts per record. Other records continue to
sync. The conflicted record's later local mutations wait behind it.

Resolution is explicit:

- accept the authoritative record and discard the queued mutation;
- edit and resubmit against the current revision;
- create a separate record where both versions should survive.

Owning applications can offer safe domain-specific resolutions for independent
field changes. General last-write-wins behavior would discard user edits and is
therefore absent from the base protocol.

Path conflicts, delete-versus-update, rename-versus-rename, and type changes use
the same conflict envelope. Batch mutations retain mdbase's validate-first
semantics within one authoritative transaction.

## Cursor expiry and recovery

The provider retains changes for a configured time and storage budget. A cursor
older than the retained boundary receives `reset_required` with the current
scope epoch and head sequence.

Recovery preserves the replica's pending mutation queue:

1. save queued mutations separately from cached records;
2. download and atomically install a fresh snapshot;
3. replay queued mutations with their original mutation IDs;
4. surface revision conflicts produced by changes at the authority.

This bounded-history model keeps storage predictable. Replica acknowledgements
support diagnostics and compaction decisions without making an abandoned device
retain history forever.

## Filesystem mirror behavior

Connect keeps replica state outside ordinary Markdown files:

- record ID to path and last authoritative revision;
- last applied document hash for echo suppression;
- snapshot epoch and change cursor;
- pending local mutations and conflicts;
- resource revisions for config and type files.

Each physical mirror folder also contains the non-secret
`.mdbase/connect-role.json` marker. It binds that folder to one hosted
collection and prevents the local connector from exposing it as another write
authority. Credentials, cursors, pending mutations, and conflicts remain in
device-local state outside the collection.

Before changing files, a Node mirror takes an exclusive device-local folder
lease. `mdbase-mirror watch` holds it until the watcher stops; one-shot sync and
conflict operations hold it for their complete critical section. Another
desktop process receives `mirror_folder_in_use` rather than running a second
engine over the same folder. Lease files use one OS-user-wide namespace that
cannot be redirected with `MDBASE_CONNECT_MIRROR_STATE_DIR`, so clients with
separate credential/state roots still contend for the same physical folder.

Incoming documents use temporary files and atomic rename where the platform
supports them. The watcher recognizes writes made by the mirror from the saved
revision and avoids uploading them again.

Receive-only mirrors pause on any local record or resource divergence before
applying another remote version. Writable mirrors scan ordinary Markdown,
preserve stable identity for exact renames, and convert creates, updates,
renames, and deletes into journaled conditional mutations. Lost responses replay
the same mutation ID. Concurrent edits persist a structured conflict in
device-local mirror state and require an explicit local or remote resolution.
The affected record pauses while unrelated records continue synchronizing.
Configuration and type documents remain receive-only until a separate
whole-collection administration capability is introduced.

## Application cache behavior

An application cache stores only records in its approved contract scope. It
opens from local state, applies user actions optimistically to the cache, and
records the corresponding mutation before reporting success to the UI.
Background and resume tasks push pending mutations and pull authoritative
changes when the operating system permits network work.

Connection state can be expressed in user terms:

- up to date;
- changes waiting to upload;
- syncing;
- action needed for a conflict;
- sign-in or permission required.

The cache contains no local filesystem path. Revoking the replica blocks future
sync immediately; the user may then keep, export, or remove its local cached
data according to application policy.

## Protocol routes

The implemented reference routes are:

```text
POST /v1/authorities/{collection}/sync/sessions
GET  /v1/authorities/{collection}/sync/snapshot
GET  /v1/authorities/{collection}/sync/changes?after={cursor}
POST /v1/authorities/{collection}/sync/mutations
```

The session response declares protocol version, replica mode, scope epoch,
retained cursor boundary, and current head. Snapshot pages use opaque
continuation tokens. Mutation responses return one durable receipt per mutation
with applied, conflicted, rejected, or previously-applied status. Replica
capabilities and versioned resource documents are included in session and
mutation enforcement. Mutations are currently submitted individually; durable
causal links preserve local ordering.

Replication is versioned independently from the mdbase spec, Connect relay
protocol, app manifest, and domain contracts. Shared Rust and TypeScript
fixtures should cover every wire object before a hosted provider is deployed.

## Security and privacy

A hosted collection is an explicit data-hosting choice. The provider stores its
record content so it can validate, query, and synchronize that collection. A
local-authority collection continues to use the transient relay and keeps its
payloads on the user's computer.

Replication tokens are bound to a replica, collection, mode, and contract
scope. Access and refresh credentials follow the existing rotation and
revocation model. Mobile credentials use the operating-system keystore;
filesystem-mirror credentials use owner-only device-local application state
and never live inside the mirrored folder. Platform keystore integration can
strengthen that storage without changing the mirror protocol.
Application-cache grants derive scope from the application's manifest.
Filesystem-mirror grants are device permissions approved by the collection
owner and can cover a full collection or selected contracts.

Provider logs and metrics contain IDs, byte counts, durations, result codes, and
sequence lag. They exclude Markdown bodies, frontmatter values, query source,
and mutation payloads. Backups are encrypted and follow the same account and
collection deletion lifecycle as live data.

The trust models for encrypted relay traffic, standard hosted collections,
private hosted collections, local files, and device caches are defined in
[Encryption architecture](./encryption.md).

## Cost and operational shape

The initial service can run with one Rust hosted-provider service and
PostgreSQL:

- current Markdown records are stored once;
- retained versions and change events have bounded lifetimes;
- snapshots are paginated and generated at stable sequence boundaries;
- application caches request contract-scoped subsets;
- acknowledgements and inactive-replica expiry prevent indefinite history;
- usage meters count current bytes, retained version bytes, mutations, and
  sync egress.

Free hosted collections can be constrained by record count, current stored
bytes, and monthly mutation volume. Those limits map directly to provider cost
and leave local and self-hosted collections unrestricted. Attachments can use
object storage with separate quotas when they enter the product.

PostgreSQL point-in-time recovery protects hosted state. Users can export a
hosted collection as an ordinary mdbase directory at any time, including its
Markdown records and type definitions.

## Implementation sequence

### 1. Protocol and storage foundation

- define shared snapshot, change, mutation, conflict, and receipt schemas;
- add stable record IDs at the provider/replica layer;
- introduce the `mdbase-rs` record-store boundary and keep the filesystem store
  conformant;
- build deterministic protocol fixtures and state-machine tests.

### 2. Hosted authority

- implement the Rust hosted provider with PostgreSQL transactions;
- create, read, query, and mutate a hosted collection through existing mdbase
  envelopes;
- publish authoritative record and resource changes atomically;
- add export, backup, quota, and deletion paths.

### 3. Application offline cache

- implement scoped initial snapshot and cursor pulls;
- persist an offline mutation queue and idempotent receipts;
- exercise offline create, update, reconnect, and conflict resolution;
- expose concise sync state in the owning application.

### 4. Receive-only Connect mirror

- materialize a full hosted collection as Markdown;
- preserve identity, paths, resources, and cursor state locally;
- detect local divergence and pause before replacement;
- approve enrollment from the Electron controller without copying a credential;
- verify complete rebuild after replica metadata loss.

### 5. Writable Connect mirror

- translate local filesystem activity into conditional mutations;
- add exact document replacement and rename handling;
- resolve echo suppression, path conflicts, deletions, and interrupted writes;
- isolate record conflicts so independent Markdown keeps synchronizing;
- add explicitly authorized config and type-resource editing.

### 6. Hosted-to-local authority handoff

- require an exact, converged full writable mirror and browser confirmation;
- freeze provider writes at a final sequence and verify a cross-language
  manifest proof;
- register the materialized folder as a local candidate before activating it;
- advance the authority epoch and revoke every old hosted capability;
- make completion retry-safe and restore hosted writes on cancellation or
  pre-cutover expiry.

Multi-user collaboration can build on the same authority and log after
single-user replication is reliable. Peer-to-peer and multi-authority merging
would require another consistency model and should be designed independently.

## First vertical slice acceptance

The automated network slice demonstrates this complete state transition:

1. Create a hosted collection and provision an example application contract.
2. Connect an application client and install a scoped snapshot.
3. Go offline and create a record with a client-generated record and mutation ID.
4. Reconnect, apply the mutation once, and receive its authoritative revision.
5. Pull the resulting `put` on a second client.
6. Materialize the same record as Markdown in a receive-only Connect mirror.
7. Submit a stale update and return a usable conflict envelope.
8. Expire a cursor, rebuild from a snapshot, and preserve a queued mutation.
9. Revoke the replica and reject its next pull, push, and token renewal.

That slice validates identity, storage, authorization, offline mutation,
delivery, mirroring, conflict, recovery, and revocation before broader sync
behavior is added.

## Decisions to confirm during the prototype

- retained change and mutation-receipt durations;
- PostgreSQL representation of canonical documents and retained versions;
- the smallest `mdbase-rs` record-store interface that serves both providers;
- exact document replacement semantics and validation diagnostics;
- mobile cache encryption and device-removal behavior;
- limits for the free hosted tier;
- the administration flow for config and type-resource changes.

These choices affect operations and ergonomics. The authority, identity,
conditional mutation, scoped projection, and reset model should remain stable
across them.
