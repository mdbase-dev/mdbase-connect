# Architecture

## Platform boundary

mdbase defines the portable collection format and record operations. Connect
provides authorization, routing, discovery, and change delivery for
applications. Domain packages interpret optional type extensions without
adding application behavior to the mdbase specification or the relay.

Five trust zones make up the local-hosted path:

1. An independently hosted frontend application.
2. A hosted or self-hosted Connect control plane and transient relay.
3. A user-owned connector daemon with a browser-only loopback service and
   outbound network connections.
4. User-owned mdbase collections on the local filesystem.
5. Optional application gateways, such as the hosted MCP service, which act as
   authorized Connect applications and translate an external protocol without
   weakening the connector's exact grant.

The connector is the authority for local data and policy. The server routes a
request only when its access token and grant allow the operation. The connector
checks its local policy copy again before it opens a collection.

## Collection identity and application selection

A local collection gets a random durable UUID the first time the connector
registers it. The connector stores it in the collection's portable
`mdbase.yaml` extension:

```yaml
x-mdbase-connect:
  collection_id: 019...
```

The identity follows the folder when it is moved or renamed; absolute paths are
never identities and never leave the connector. If a copied folder presents
the same ID while the original remains registered, the connector rejects the
copy and asks the user to establish a distinct identity instead of silently
aliasing two authorities. The desktop's explicit **Register copy** action, or
`mdbase connect collection add-copy PATH`, writes a new random ID only after
the connector has proved that the selected path is a copy of a different,
still-registered folder. It refuses the registered original, a moved folder,
and a collection that can be registered normally.

A physical folder has exactly one Connect storage role. A hosted mirror stores
this non-secret device role in `.mdbase/connect-role.json`, outside the
receive-only `mdbase.yaml` resource. The local connector refuses to register
such a folder as a filesystem authority. If a folder was registered before it
became a hosted mirror, the connector immediately reports it as unavailable and
denies operations; it does not rely on the next control-plane heartbeat for
safety.

Mirror processes also take an exclusive device-local lease keyed by the
folder's canonical path and filesystem identity. A long-running watcher holds
the lease for its lifetime, so the desktop mirror and an Obsidian mirror plugin
cannot manage the same physical folder concurrently even when the clients keep
separate application-state directories. The Node adapter uses one fixed
OS-user-wide lease namespace; custom mirror adapters must provide equivalent
cross-application exclusion when they cannot use it.

The control plane provides the final identity-level fence. If a connector
publishes the ID of an active hosted collection, it is retained only as a
disabled authority candidate until an approved authority transfer completes.
This is defense in depth: the folder marker prevents a same-folder/different-ID
mistake locally, while the server prevents two active authorities for the same
ID.

The SDK is multi-collection by default. `MdbaseConnect` manages the saved
authorization set, `MdbaseConnection` is permanently bound to one collection,
and `MdbaseSession` owns the active selection and authorization lifecycle.
Browser applications supply `MdbaseBrowserSelection`, which puts the stable
server collection ID, not the mutable display name, in
`?collection=<id>`. Session snapshots distinguish unselected, ready, and
explicitly unavailable bookmarks; switching validates and publishes the new
connection atomically without reloading the application.

Authorization intent is explicit. A choose request accepts any compatible
collection, while selected or exact-target requests must return the named
collection. Collection IDs are non-secret locators and can appear in browser
history and logs; grants remain the authorization boundary.

## Collaboration boundary

Collection visibility and authority are deliberately separate. A
`CollectionLocator` identifies one logical collection, its current local or
hosted authority row, owner, authority epoch, and state. Local locators use the
portable `local_id`; hosted locators use the hosted collection ID. Routes do
not infer identity from a mutable name or filesystem location.

All user-to-collection decisions pass through the collection catalog and
access-policy modules. The current resolver emits only owner access. Its
context already carries relationship, policy revision, product actions,
operation ceiling, and contract/full-collection scope ceiling, so adding
membership later is confined to those repository and policy boundaries.
Collection responses include an access summary and explicit authority
metadata rather than asking clients to infer permissions from ownership.

Application capabilities are computed by a pure grant planner. It intersects
the operations selected by the user, the application's request and manifest,
and the user's current operation and scope ceilings. Provisioning is a
separate `schema.manage` action. Token renewal re-resolves access, which makes
membership removal fail closed without rewriting OAuth.

Every hosted replica records the user whose access authorized it, while the
provider records the source replica on each record change. Revocation first
atomically disables the grant, tokens, and replica in the control plane, then
delivers provider cleanup from a durable retry queue. These attribution and
lifecycle boundaries allow later member removal and role changes to target
derived capabilities without taking the service offline.

## Components

- `mdbase-rs` owns collection loading, validation, querying, mutation,
  revisions, and normalized filesystem events.
- `connect-agent` owns collection registration, local policy enforcement, the
  local change journal, local runtime authority, activity, browser loopback
  access, and outbound relay connectivity.
- `connect-runtime` translates manifest criteria and exact grants into
  provider-neutral runtime contracts without owning collection semantics.
- `connect-cli` and the Electron controller use the agent's versioned local
  control socket.
- `connect-server` owns accounts, pairing, app discovery, grants, token
  issuance, collection access policy, audit metadata, and transient request
  routing. Its schema changes use the versioned, pre-deploy process in
  [Control-plane migrations](./control-plane-migrations.md).
- `mdbase-editor` owns both the collection editing surface and an account-only
  Connect workspace. The two routes use separate clients and authorities.
- `@mdbase/connect-management` is the narrow browser client for account
  inventory and administration. It cannot perform collection operations.
- `connect-mcp` owns MCP host OAuth sessions and encrypted upstream Connect
  credentials. It uses one exact Connect grant per approved collection and
  never shares a collection grant across MCP connection sets.
- `@mdbase-dev/connect` provides OAuth with PKCE, typed operation envelopes,
  collection discovery, end-to-end encrypted relay operations, cursor-based
  subscriptions, and Web Push installation registration.
- `@mdbase-dev/connect-sync` defines hosted replication and supplies offline replica
  stores, an HTTP transport, and a receive-only Markdown mirror.
- Domain adapters consume collection contracts and remain in their owning
  application repositories.

First-class non-record files use a separate logical namespace, grant
capability, binary transfer data plane, blob store, and replication object
while retaining ordinary collection-relative paths. The complete design is in
[Collection files](./files.md).

## Collection API

Connect protocol 1 exposes these grantable operations:

- `describe`, `changes`
- `read`, `query`, `validate`, `list_views`, `execute_view`
- `create`, `update`, `delete`, `rename`
- `read_type`, `create_type`, `update_type`, `assess_type_pack`, `apply_type_pack`
- `list_timers`, `put_timer`, `cancel_timer`, `reconcile_timers`

mdbase operations retain the canonical `{ valid, result, diagnostics }`
envelope. Reads and successful writes carry opaque revisions. Mutations accept
`if_revision`, which allows clients to prevent lost updates without knowing
how a provider constructs its revision token. The public TypeScript SDK unwraps
valid envelopes into typed `ConnectOutcome` values and converts invalid
envelopes into recovery-oriented problems while preserving their diagnostics.

An application manifest may require exact data-contract versions. These
requirements determine collection compatibility and provisioning. Access is
contract-scoped by default: the connector pins the exact contract plus every
approved implementation, unions those provider types, and exposes normalized
contract views for queries, direct record access, mutations, and change
delivery. Applications that need collection-level
features such as saved views may declare `requirements.access` as
`full_collection`; their contract requirements continue to govern compatibility
and setup. Query type filters are constrained locally for contract-scoped
grants; direct paths are checked against matched record types; and updates and
renames are checked against their prospective type membership before writing.

An application manifest may pair required contracts with portable type packs.
A collection is then either ready, provisionable, or incompatible. During
approval, the authority installs each required pack as one preflighted
transaction, reopens the collection, and verifies the exact contract and
implementation digests before creating a grant. A pack contains the contract,
every implementing type, and any referenced schemas; a failure writes none of
them. This setup action does not give the application continuing `create_type`
or `update_type` permission. A full-collection application may separately
request `apply_type_pack`. It first calls `assess_type_pack`, presents the
structured resource and lock diff for review, then applies that exact
assessment digest. The authority rechecks live state inside the write
transaction, records publisher source paths separately from resolved collection
targets, and refuses unmanaged or locally modified targets without explicit
digest-pinned adoption. Local collection paths and record payloads remain
outside the control plane.

`describe` returns the collection's spec version, supported operations, JSON
Schemas, collection-relative type paths, complete portable type definitions,
canonical collection settings, first-class contract descriptors, and the
current change cursor. It omits absolute paths and
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

## Runtime notifications

An application manifest may declare notification criteria over canonical
runtime events. The local connector or hosted collection provider—not the
control plane—journals each event, evaluates CEL, applies debounce and
minimum-interval rules, and rechecks the exact current grant immediately before
dispatch. Durable one-shot timers use the same path and wake after authority
restart. Application timer keys are derived from the grant and app namespace;
the runtime workflow also requires the same grant and criterion in the timer
payload, preventing another grant's timer from matching it.

The authority sends only an idempotent signal ID, grant ID, criterion ID, and
opaque cursor to the control plane. The control plane adds static manifest
presentation and retries delivery through a leased outbox. Delivery can target
registered Web Push installations, registered FCM tokens when the application
opts into Connect-managed sending, or one signed application webhook. Paths,
record payloads, runtime event payloads, and collection contents never cross
this boundary. Applications treat a notification as a wake-up hint and read
current authorized state after opening. See
[Runtime-backed notifications](./notifications.md).

Notification criteria are snapshotted into the grant at approval. Manifest
rediscovery can retain exactly equivalent criteria or remove changed ones, but
cannot add evaluation logic to an existing grant. Changed criteria therefore
require explicit reauthorization before the authority receives an updated
policy.

## Contracts

An `mdbase.contract` is a versioned, digest-addressed JSON Schema artifact.
Its explicit `contract_type` is `record`, `event`, or `action`. Connect's
collection-operation grants use record contracts: a type opts in through
`implements`, which maps stable contract fields to concrete fields. Several
types may implement the same record contract; reads and queries union those
implementations and return one normalized view. If a record has more than one
approved view, the application supplies the exact `{ id, version, type }`
selector.

Event sources and action providers are executable application declarations,
not type implementations. They use the mdbase event/action interoperability
profile and CloudEvents envelope. Connect ships exact copies of those portable
schemas from `@mdbase-dev/connect-protocol`; a future durable binding can add
authority routing, journals, and offline delivery without defining another
event/action vocabulary. Installing or validating any contract grants no
authority.

Contract-scoped applications never receive the raw Markdown body or unmapped
frontmatter. Writes accept normalized contract fields and the authority maps
them back through the selected implementation. Full-record access is a
separate, explicitly approved capability.

Application adapters implement their behavior through generic mdbase
operations. Revision-sensitive changes read the latest revision and submit a
conditional update. Runtime-backed notification criteria and one-shot timers
remain generic; domain planning stays in the application.

## Application identity and authorization

Account sign-in is separate from application authorization. An account may
have external, email, password, and eventually passkey or TOTP credentials.
Identity linking always requires fresh proof of both sides; matching email text
never merges accounts. GitHub OAuth binds its callback to a one-time browser
state and PKCE verifier. Google Identity Services binds its signed ID token to
a one-time browser nonce. Provider subjects, rather than email addresses or
mutable usernames, identify external accounts. GitHub access tokens are used
only to fetch the identity and are not retained; Google access tokens are not
requested. Registration supports closed, invitation-only, and open policy.
The deployment setting is the fail-safe default, while an audited,
revision-controlled database policy supports an immediate kill switch across
all instances. Local development can use an explicitly enabled unverified
email session; public origins refuse that mode. See
[Account authentication](./account-authentication.md).

Applications bundle a v1 manifest and send it inline during registration.
Connect canonicalizes the manifest and identifies that exact content by its
SHA-256 digest; the reverse-domain application ID and other
presentation fields are explicitly not publisher authentication. Authorization
uses short-lived codes and PKCE; browser and native applications have no client
secret. The user approves concrete operations and the declaration-derived
record scope for one named collection.

Downloaded HTML applications use the v1 portable distribution profile described
in [portable-apps.md](portable-apps.md). They make no web-origin claim and use a
single-use OAuth device code plus PKCE and independent per-grant P-256
agreement and signing keys.
Their browser origin is the exact opaque value `null`, tokens and non-extractable
keys are memory-only by default. A local connector requires a matching
encrypted grant for every operation. A hosted provider instead receives a
short-lived capability bound to the exact grant, collection, operation set,
record scope, expiry, opaque `null` origin, and application signing public key. Every
hosted request and refresh carries a replay-protected ECDSA proof over its
method, target, body, credential, timestamp, and nonce. The SDK exposes the same
connection API for both routes.
Collections that do not provide the required contracts are excluded from the
decision. Local pause and revocation take effect at the connector even when
cloud policy is stale.

Changing a manifest creates a new application identity and never mutates an
older grant. The previous installation credential remains bound to its exact
approved manifest; authorizing the changed manifest requires another explicit
decision. Applications load their own bundled v1 manifest and register its
contents inline. The control plane never fetches an application-supplied URL.

Authorization codes issue a one-hour access token and a rotating 30-day refresh
token. Refresh tokens are single-use, bound to the application and grant, and
revoked with the grant. Browser clients renew shortly before expiry and retain
the rotated credential in application-owned storage.

New authorizations use operation transport v3 and grant encryption profile v1
to encrypt each operation end to end between an authorized application
installation and the local connector. The relay sees the operation and routing
metadata but carries opaque request and response payloads. Hosted collections
use a separate provider encryption boundary. The complete trust, key, metadata,
and rollout design is in
[Encryption architecture](./encryption.md).

The editor's Connect workspace is the primary remote collection, permission,
computer, and account surface. The Electron controller remains primary for
local-folder authority and mirror operations. The portal handles sign-in,
pairing, account recovery, and authorization approval only.

Account and collection authority stay separate. The editor sends the HttpOnly
account cookie only to the Connect origin, with browser credentials enabled;
the server accepts it only when `Origin` exactly matches
`MDBASE_CONNECT_MANAGEMENT_ORIGINS`. That session can use account APIs but is
not a collection grant. Opening a collection navigates to
`?collection=<id>` and lets `MdbaseSession` reuse or request the editor's exact
application grant. Managed deployments keep Connect and editor on the same
site so `SameSite=Lax` remains effective while the two origins stay isolated.

## Direct local transport

Local-authority grants synchronize the application's exact approved origin to
the connector. The browser SDK can then send the v1 encrypted operation envelope
to `http://127.0.0.1:28485/v1/operations`. The fixed endpoint reveals only
generic protocol readiness. It is separate from the Unix socket or Windows
pipe used for desktop administration and exposes all grantable collection
operations through the same connector handler as the relay.

The loopback listener binds only IPv4 and IPv6 loopback, validates the exact
`Host` and grant origin, returns exact-origin CORS headers, omits ambient
credentials, requires `application/mdbase-connect+json`, and bounds request
size, concurrency, execution time, and per-origin rate. The v1 cryptographic binding
remains the operation authority; CORS is an additional browser boundary.

Chrome's Local Network Access permission is requested from an explicit app
action. Once granted, routing is automatic and the UI may quietly report
`Connected directly`. Unsupported, denied, absent, or incompatible local
access falls back to the encrypted relay without changing application record
code. Hosted authorities continue to use their provider directly.

Every authenticated request is claimed in the connector's durable replay
window. The completed encrypted response is stored as a receipt. If a direct
response is lost, the SDK retries the exact envelope through the relay and the
connector returns that receipt instead of executing the operation again.
Authenticated counters may arrive out of order within a bounded 1,024-message
window so concurrent browser requests remain safe and usable.

## Data authority and hosted replication

Every collection has one write authority:

- a local connector for a filesystem-backed collection;
- a hosted collection provider for the managed service;
- a self-hosted provider implementing the same Connect API.

A hosted-authority folder may be mirrored into ordinary Markdown, but that
folder cannot also be relayed by the local connector. Changing roles is an
explicit authority transfer: converge and fence the current authority, verify
the complete mirror, change the folder role, then activate the new authority.
Rollback restores the hosted-mirror role before hosted writes resume.

The hosted vertical slice implements stable IDs, pinned snapshots, ordered
scoped changes, conditional replay-safe mutations, offline caches, conflicts,
cursor reset, revocation, versioned type and contract discovery, runtime-backed
notification evaluation, and receive-only or writable Markdown mirrors. The
Rust provider is the production authority over normalized transactional
storage. The filesystem-neutral mirror core uses a Node adapter for local
directories; other clients can supply their own filesystem implementation
without duplicating collection semantics.

The detailed hosted-provider, offline-cache, and filesystem-replication design
is in [Hosted collections and sync](./sync.md).

## Versioning

The mdbase spec version, Connect protocol version, app manifest version, and
data-contract versions evolve independently. The unreleased wire contracts
all begin at v1. Future incompatible formats will use new declared versions and
ship as coordinated agent, server, and SDK releases.

Internal module ownership, dependency direction, quality budgets, and the
definition of done are specified in
[Code quality and internal architecture](./code-quality.md).
