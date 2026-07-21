# Architecture

## Platform boundary

mdbase defines the portable collection format and record operations. Connect
provides authorization, routing, discovery, and change delivery for
applications. Domain packages such as `@mdbase/tasknotes` interpret optional
type extensions without adding TaskNotes behavior to the mdbase specification
or the relay.

Four trust zones make up the local-hosted path:

1. An independently hosted frontend application.
2. A hosted or self-hosted Connect control plane and transient relay.
3. A user-owned connector agent with outbound network connections.
4. User-owned mdbase collections on the local filesystem.

The connector is the authority for local data and policy. The server routes a
request only when its access token and grant allow the operation. The connector
checks its local policy copy again before it opens a collection.

## Components

- `mdbase-rs` owns collection loading, validation, querying, mutation,
  revisions, and normalized filesystem events.
- `connect-agent` owns collection registration, local policy enforcement, the
  local change journal, activity, and outbound relay connectivity.
- `connect-cli` and the Electron controller use the agent's versioned local
  control socket.
- `connect-server` owns accounts, pairing, app discovery, grants, token
  issuance, audit metadata, and transient request routing.
- `@mdbase/connect` provides OAuth with PKCE, typed operation envelopes,
  collection discovery, end-to-end encrypted relay operations, and cursor-based
  subscriptions.
- `@mdbase/connect-sync` defines hosted replication and supplies offline replica
  stores, an HTTP transport, and a receive-only Markdown mirror.
- Domain adapters consume collection contracts. `@mdbase/tasknotes` is the
  first adapter and follows the collection's configured TaskNotes field roles.

## Collection API

Connect protocol 2 exposes these grantable operations:

- `describe`, `changes`
- `read`, `query`, `validate`
- `create`, `update`, `delete`, `rename`

mdbase operations retain the canonical `{ valid, result, diagnostics }`
envelope. Reads and successful writes carry opaque revisions. Mutations accept
`if_revision`, which allows clients to prevent lost updates without knowing
how a provider constructs its revision token.

An application manifest may require exact domain contract versions. Approval
turns those requirements into a grant scope. The connector resolves each
contract to its current local type and applies the scope to discovery, queries,
direct record access, mutations, and change delivery. Query type filters are
constrained locally; direct paths are checked against matched record types; and
updates and renames are checked against their prospective type membership
before writing. Collection-wide validation and cross-record reference rewriting
are unavailable to a contract-scoped grant. Scoped queries reject link
traversal into other records until the query engine can carry the grant scope
through link resolution.

An application manifest may pair required contracts with portable type provisions.
A collection is then either ready, provisionable, or incompatible. During
approval, the authority that owns the collection installs only provisions
needed for missing contracts, reopens the collection, and verifies the exact
contract identities and versions before a grant is created. This setup action
does not give the application continuing `create_type` or `update_type`
permission. Local collection paths and record payloads remain outside the
control plane; only the declared type documents and resulting contract metadata
participate in authorization.

`describe` returns the collection's spec version, supported operations, JSON
Schemas, collection-relative type paths, complete portable type definitions,
canonical collection settings, `x-*` type extensions, discovered contract
declarations, and the current change cursor. It omits absolute paths and
implementation-specific or extension values from the collection configuration.

## Change delivery

The engine debounces filesystem notifications and compares a fresh collection
snapshot. Editor-specific write sequences therefore become a single
final-state event when possible. The connector records normalized event
metadata in its local SQLite database with a monotonically increasing cursor.

The public `changes` operation is resumable and paginated. Calling it without
an `after` cursor establishes a subscription at the current point and does not
replay earlier activity. The browser SDK builds an async change stream by
polling pages from that cursor. Expired cursors require a state refresh.

The local journal stores paths, event kinds, revisions, matched types, and
changed-field names. Record snapshots are removed before persistence. The
hosted relay does not persist change events or operation payloads.

## Domain contracts

A type may declare an optional domain contract in an extension such as
`x-tasknotes`. Discovery returns the extension unchanged along with its type
name and version. An adapter can then translate stable domain roles into the
collection's configured field names.

The TaskNotes adapter implements listing, creation, and completion through
generic mdbase operations. Completion reads the latest revision and submits a
conditional update. This path works while Obsidian is closed. Behaviors that
need a richer runtime, including recurrence expansion and timers, will use
explicit provider actions in a later Connect protocol revision. Generic record
access does not pretend those actions are available.

## Application identity and authorization

Account sign-in is separate from application authorization. External identity
providers normalize verified identities into a shared account and session
boundary. GitHub OAuth binds its callback to a one-time browser state and PKCE
verifier. Google Identity Services binds its signed ID token to a one-time
browser nonce. Provider subjects, rather than email addresses or mutable
usernames, identify accounts. GitHub access tokens are used only to fetch the
identity and are not retained; Google access tokens are not requested. Closed
registration admits only configured provider subjects. Local development can
use an explicitly enabled unverified email session; public origins refuse that
mode.

Web applications are identified by the exact origin of an HTTPS manifest at
`/.well-known/mdbase-app.json`. Authorization uses short-lived codes and PKCE;
browser applications have no client secret. The user approves concrete
operations and the manifest-derived record scope for one named collection.
Collections that do not provide the required contracts are excluded from the
decision. Local pause and revocation take effect at the connector even when
cloud policy is stale.

Manifest rediscovery reconciles older active grants. A newly declared contract
scope may narrow a collection-wide grant when the collection is compatible;
incompatible grants are revoked. A manifest change never broadens an existing
grant without another approval.

Authorization codes issue a one-hour access token and a rotating 30-day refresh
token. Refresh tokens are single-use, bound to the application and grant, and
revoked with the grant. Browser clients renew shortly before expiry and retain
the rotated credential in application-owned storage.

New authorizations use protocol 3 to encrypt each operation end to end between
an authorized application installation and the local connector. The relay sees
the operation and routing metadata but carries opaque request and response
payloads. Protocol 2 remains an explicitly selected migration mode and allows
the relay to read payloads in memory. Hosted collections use a separate
provider encryption boundary. The complete trust, key, metadata, and rollout
design is in
[Encryption architecture](./encryption.md).

The Electron controller is the primary collection and permission surface. The
portal handles sign-in, pairing, account state, remote approval on trusted
private deployments, and emergency computer revocation.

## Data authority and hosted replication

Every collection has one write authority:

- a local connector for a filesystem-backed collection;
- a hosted collection provider for the managed service;
- a self-hosted provider implementing the same Connect API.

The hosted vertical slice implements stable IDs, pinned snapshots, ordered
scoped changes, conditional replay-safe mutations, offline caches, conflicts,
cursor reset, revocation, versioned type and contract discovery, and a one-way
Markdown mirror. Its TypeScript
authority and versioned PostgreSQL state document are a reference
implementation for the protocol. The production hosted authority will move
mdbase behavior into a Rust provider backed by normalized transactional
storage. A bidirectional filesystem mirror still requires outbound document
replacement, watcher echo suppression, and user-facing conflict handling.

The detailed hosted-provider, offline-cache, and filesystem-replication design
is in [Hosted collections and sync](./sync.md).

## Versioning

The mdbase spec version, Connect protocol version, app manifest version, and
domain contract versions evolve independently. Clients branch on declared
versions and capabilities. Protocol 2 is introduced as one coordinated agent,
server, and SDK release; protocol 1 installations must be upgraded together in
private staging.
