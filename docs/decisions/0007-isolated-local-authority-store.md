# ADR 0007: Isolated local authority store and operation-class replay

- Status: accepted
- Date: 2026-08-10

## Context

The local connector currently stores grants, encrypted request replay state,
durable mutation recovery, collection indexes, sync state, activity, and full
encrypted operation responses in one SQLite database. SQLite permits one
writer. Under concurrent Reader and Editor hydration, multi-megabyte read
response commits can therefore starve a relay policy replacement until its
five-second busy timeout expires. Policy handling currently runs in the relay
socket receive path, so the same delay can also prevent timely Ping/Pong and
disconnect the relay.

The failure is not corruption and is not solved by increasing SQLite's busy
timeout. The persistence topology lets data-plane volume consume the security
control plane's writer and event-loop budgets.

## Decision

The connector will use an isolated local authority store and operation-class
replay semantics. This is the final architecture, not an intermediate
single-database deployment.

### Authority store

`authority.sqlite` is the canonical store for state whose ordering determines
whether remote work is admitted:

- the exact installed policy revision and active grant snapshot;
- retired grant/key material retained only for authenticated recovery;
- the local pause boundary and other authorization overlays;
- encrypted request counter windows and request bindings;
- durable mutation claims, leases, evidence, terminal state, and tombstones;
- immutable receipt digests, sizes, and storage references.

One long-lived writer service owns the only writable authority connection.
Callers submit bounded commands through reserved priority lanes. Policy,
revocation, pause, and fencing work have reserved capacity; mutation recovery
and ordinary admissions use separately bounded lanes; maintenance runs in
small batches. No authority transaction may contain an operation response,
record snapshot, file body, or other unbounded application payload.

Policy replacement, retired-key archival, revision persistence, and the local
authorization epoch commit atomically. A successful acknowledgement names the
revision actually committed. Fresh request admission is serialized against
that transaction, so a request cannot observe one policy and durably claim
under another. Existing mutation recovery is resolved under the revocation
rules in ADR 0005.

Readers use an immutable in-memory snapshot published only after the authority
transaction commits. Startup reconstructs that snapshot solely from the
authority store. Failure to open or validate the authority store is fail
closed.

### Operational store

`connector.sqlite` remains the canonical store for collection registration,
paths, indexes, change history, sync state, file-transfer bookkeeping,
inventory, and activity. It has an independent writer boundary. An operational
write failure may fail an operation, but cannot acquire the SQLite writer used
to install policy or maintain encrypted request admission.

Security-relevant local controls have one canonical representation in the
authority store. Operational views may project that state but never become a
second authorization source.

### Durable receipt store

Exact encrypted mutation receipts and any large recovery artifacts live under
an owner-only, directory-sharded receipt store. Blobs are immutable and named
by digest. Publication order is:

1. write a temporary file on the target filesystem;
2. flush and fsync it;
3. atomically rename it to its digest-derived path;
4. fsync the containing directory where supported;
5. commit the digest, size, and reference in `authority.sqlite`;
6. send the response.

A crash before step 5 may leave an orphan that garbage collection can remove.
A committed journal row never intentionally points to an undurable blob. A
missing or invalid referenced blob is a fail-closed recovery error and never
permission to repeat a mutation.

Retention is bounded by the ADR 0005 mutation recovery horizon and tombstone
contract. Cleanup is incremental and cannot delete unresolved mutation
evidence.

### Replay classes

The generated operation catalogue determines replay class. A client cannot
select or downgrade it.

Mutations retain the ADR 0005 contract: one durable semantic identity, fenced
recovery, and an exact encrypted terminal receipt. Transport retries reuse the
logical request ID and recover that receipt even after route changes,
revocation, or restart within the advertised recovery horizon.

Non-mutating reads durably advance only the authenticated counter window and
bind the recently accepted envelope. In-flight work and completed encrypted
responses may be coalesced in a byte-, count-, and age-bounded in-memory cache.
If an identical read arrives after restart or cache eviction, the connector
returns the visible transport problem `fresh_request_required` and does not
encrypt a second response under the old response nonce. The SDK allocates a
new request ID and counter, re-encrypts, and retries only the non-mutating
operation.

This rule is required because transport v3 derives the AES-GCM response nonce
from the request counter. Recomputing a read whose result changed and
encrypting it under that counter would reuse a nonce with different plaintext.
Transport v3 makes fresh-read retry an explicit cross-runtime contract.

Watches use resumable cursors and bounded long polling or pushed notifications.
Repeated watch polls are ordinary fresh reads, never long-lived durable
response receipts.

### Relay scheduling

The WebSocket owner performs framing, bounded routing, Ping/Pong, and response
transmission; it does not execute SQLite work. A policy snapshot installs an
ingress barrier for later application operations while its authority command
runs. The socket continues servicing control frames. Application queues are
bounded by count and bytes and overload produces a typed response rather than
unbounded tasks, policy starvation, or relay loss.

Policy acknowledgement follows durable commit and in-memory publication. A
policy storage failure keeps the previous local policy, fails closed for the
unacknowledged revision, and leaves the relay session available for retry and
diagnostics.

## Migration

The beta migration is a single crash-resumable startup transition:

1. create and authenticate a backup of the legacy `connector.sqlite`;
2. build `authority.sqlite` and the receipt store at temporary paths;
3. copy and verify grants, replay windows, request bindings, retired keys,
   mutation journals, tombstones, and mutation receipts;
4. discard legacy completed read-response bodies rather than copying them;
5. publish a durable migration manifest selecting the new layout;
6. remove legacy authority tables from the operational database and reclaim
   their pages;
7. retain the authenticated legacy backup for the documented rollback window.

Every phase is idempotent. A process death before manifest publication starts
again from the legacy database. A process death after publication opens only
the new layout and resumes cleanup. Existing unresolved and terminal mutation
receipts migrate losslessly; disposable read receipts do not.

Transport v3 remains the current SDK/connector contract. ADR 0008 supersedes
the original coordinated-only rollout: beta.57 adds a bounded, signed
transport-v2 recovery path for durable work created before the upgrade.
Unsupported or unsigned downgrade attempts still fail before operation
execution.

## Consequences

SQLite remains the storage engine. The problem was ownership and payload
placement, not SQLite's crash-recovery model.

The design adds a second database and an immutable blob lifecycle, but avoids
distributed transaction semantics on the authorization boundary: policy and
admission metadata remain together, and blob publication is pointer-last.

Backups and diagnostics become profile-wide. They must report both database
schema versions, the selected migration generation, referenced and orphaned
receipt bytes, queue latency, transaction duration, and integrity results.

## Required proof

Before staging acceptance, automated tests must cover:

- policy replacement during sustained maximum-size reads and mutation receipt
  commits without relay loss or unbounded policy latency;
- request admission racing revocation, rotation, pause, and collection disable;
- exact mutation recovery at every ADR 0005 fault boundary;
- read duplicate coalescing, cache eviction, restart, and fresh-counter retry;
- receipt publication failure before and after every filesystem/database step;
- migration interruption at every durable phase, repeat migration, rollback
  backup validation, and large legacy-database page reclamation;
- bounded queues, cleanup, WAL growth, retained bytes, and overload outcomes;
- Linux, macOS, and Windows-compatible atomic-file behavior; and
- direct, relayed, hosted, reconnect, and large-vault application journeys.
