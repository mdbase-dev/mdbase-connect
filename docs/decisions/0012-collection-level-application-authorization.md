# ADR 0012: Collection-level application authorization

- Status: accepted
- Date: 2026-08-31

## Context

Application grants currently have two data-visibility modes. A
`full_collection` grant can operate on every record in one collection, while a
`contract` grant resolves approved portable contracts to collection-local types
and filters records, queries, mutations, snapshots, changes, and notifications
through those types.

Every deployed first-party consumer has converged on full-collection access.
The Editor and TaskNotes production manifests both request it because useful
application behavior crosses type boundaries: saved views, files, definitions,
relationships, repair, synchronization, and collection-wide consistency cannot
be represented truthfully as an isolated set of record types.

Type-derived authority also depends on mutable semantic state. A malformed
record may have no classifiable current type; a contract provider can change;
and a graph operation may need out-of-scope records to report a complete
answer. Local and hosted authorities consequently carry parallel contract
projection, filtering, epoch, reconciliation, and recovery machinery despite
not having a production consumer for selective visibility.

The collection is already the unit the user selects, names, hosts, mirrors,
revokes, and grants to an application. Capabilities independently describe the
actions an application may perform.

## Decision

The collection is the minimum data-authorization boundary for an application.
An application grant authorizes:

> one application installation + one collection + explicit capabilities

An active grant never authorizes only selected record types or contracts. Every
record in the selected collection is within its data visibility boundary.
Operation, file, definition, timer, notification, origin, credential, replica
mode, and collection-member restrictions remain independently enforced.

Portable contracts remain semantic requirements. They continue to support:

- collection compatibility assessment;
- discovery and field-role mapping;
- type-pack and configuration provisioning;
- validation and application adapters; and
- notification event interpretation.

Contracts and local types do not participate in grant scope, record visibility,
or mutation authority.

Per-record semantic projections remain part of hosted query, validation, type
behavior, and recovery. This decision removes their use as an authorization
filter; it does not remove semantic projection generally.

## Migration

New application declarations must explicitly request collection access.
Omitted access retains its legacy scoped meaning for rejection and is never
interpreted as collection-wide. During the bounded N-1 compatibility window,
the existing declaration and response field may remain with the single
canonical value `full_collection`; it is a compatibility shape, not an
independent authority choice.

Existing grants migrate as follows:

- An active full-collection grant keeps its identity and credentials because
  its authority does not change.
- An unexpected active contract-scoped grant is revoked and must be explicitly
  reauthorized. It is never widened in place.
- Revocation retires access and refresh tokens, local policy authority, hosted
  replica credentials, snapshots, cursors, feeds, and the ability to start a
  new mutation.
- A durable mutation accepted before revocation may retain only the evidence
  needed to return its exact recorded outcome. Replay cannot authorize changed
  input or new work.

The migration runner retires persisted legacy grants in one transaction using
the same durable revocation state: credentials and replica tokens are revoked,
provider cleanup remains associated with the grant, and only an aggregate
retired count is emitted as deployment evidence. A separate production
inventory or identity-bearing audit is not a prerequisite: known consumers are
collection-wide, and the safe fallback for any unexpected legacy grant is
revocation rather than disclosure.

An already connected local authority is bounded by its existing policy lease.
A deployment must not treat retirement as complete until the maximum old lease
has expired; relay refreshes exclude retired grants immediately. This bounded
fence is temporary migration behavior, not a second authorization model.

Existing full-collection replicas require no snapshot reset, credential
rotation, or data rewrite solely for this migration. Reauthorization of a
legacy scoped grant creates a fresh collection-wide grant and replica, so a
selective snapshot or cursor is never widened in place.

## Delivery

1. Stop accepting new contract-scoped declarations and issue only canonical
   collection grants.
2. Make reconciliation revoke persisted contract-scoped grants while preserving
   existing full-collection grants.
3. Remove type-derived filtering from the local authority.
4. Remove type-derived filtering from hosted reads, queries, mutations,
   snapshots, changes, files, and notifications.
5. Remove obsolete protocol, SDK, UI, persistence, and recovery state after the
   signed N-1 and rollback windows close.

The existing scope epoch also fences credentials and policy changes. Preserve
that fence while scope filtering is removed; rename it to an authorization or
credential epoch only when the old representation can be replaced directly.

Temporary compatibility must name its consumer and removal condition. The old
`contract` declaration may be parsed only to return a clear unsupported or
reauthorization result. It must not remain as a second functional authority
model.

## Consequences

- Consent becomes simpler and explicit: an application can access all records
  in the selected collection, subject to the listed actions.
- Adding a new type or changing a record's type does not silently change which
  applications can see it.
- Malformed type evidence cannot strand a record behind the authorization
  boundary.
- Applications requiring stronger data separation must use separate
  collections, not mutable type classification inside one collection.
- A user cannot delegate application authorization for only selected record
  types. Collection-member roles may restrict actions, but a member allowed to
  authorize applications does so for the collection data boundary.
- Local and hosted authorization converge on one model and can delete contract
  projection, filtering, and reconciliation code.
- The migration may require an unexpected legacy application to request access
  again; this is preferable to silently disclosing additional records.

## Verification

The migration is complete only when tests prove that:

- a collection grant can observe existing and newly introduced record types;
- required contracts still control compatibility and setup without controlling
  visibility;
- denied capabilities and file actions remain denied on local, relay, and
  hosted routes;
- a legacy scoped grant is revoked rather than widened;
- retired credentials cannot read, mutate, resume a cursor, open a snapshot, or
  consume changes;
- accepted durable mutations preserve exact outcome replay without granting new
  work; and
- Editor and TaskNotes pass local, hosted, relay, restart, revocation, and
  reauthorization acceptance.
