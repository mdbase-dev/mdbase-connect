# Architecture

## Platform boundary

mdbase defines the portable collection format and record operations. Connect
provides authorization, routing, discovery, and change delivery for
applications. Domain packages interpret optional type extensions without
adding application behavior to the mdbase specification or the relay.

Five trust zones make up the local-hosted path:

1. An independently hosted frontend application.
2. A hosted or self-hosted Connect control plane and transient relay.
3. A user-owned connector agent with a browser-only loopback service and
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
`mdbase-connect collection add-copy PATH`, writes a new random ID only after
the connector has proved that the selected path is a copy of a different,
still-registered folder. It refuses the registered original, a moved folder,
and a collection that can be registered normally.

The browser SDK is multi-collection by default. `MdbaseConnect` manages the
saved authorization set, `MdbaseConnection` is permanently bound to one
collection, and `MdbaseBrowserLocation` owns bookmark selection and OAuth
return cleanup. It puts the stable server collection ID, not the mutable
display name, in `?collection=<id>`, preserves explicit unavailable IDs, and
auto-selects only when exactly one connection is saved. Authorization may carry
that ID as a preselection hint, but the approval UI still requires an explicit
compatible user choice. Collection IDs are non-secret locators and can appear
in browser history and logs; grants remain the authorization boundary.

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
  issuance, audit metadata, and transient request routing.
- `connect-mcp` owns MCP host OAuth sessions and encrypted upstream Connect
  credentials. It uses one exact Connect grant per approved collection and
  never shares a collection grant across MCP connection sets.
- `@mdbase/connect` provides OAuth with PKCE, typed operation envelopes,
  collection discovery, end-to-end encrypted relay operations, cursor-based
  subscriptions, and Web Push installation registration.
- `@mdbase/connect-sync` defines hosted replication and supplies offline replica
  stores, an HTTP transport, and a receive-only Markdown mirror.
- Domain adapters consume collection contracts and remain in their owning
  application repositories.

## Collection API

Connect protocol 1 exposes these grantable operations:

- `describe`, `changes`
- `read`, `query`, `validate`, `list_views`, `execute_view`
- `create`, `update`, `delete`, `rename`
- `list_timers`, `put_timer`, `cancel_timer`, `reconcile_timers`

mdbase operations retain the canonical `{ valid, result, diagnostics }`
envelope. Reads and successful writes carry opaque revisions. Mutations accept
`if_revision`, which allows clients to prevent lost updates without knowing
how a provider constructs its revision token.

An application manifest may require exact domain contract versions. These
requirements determine collection compatibility and provisioning. Access is
contract-scoped by default: the connector resolves each contract to its current
local type and applies that scope to discovery, queries, direct record access,
mutations, and change delivery. Applications that need collection-level
features such as saved views may declare `requirements.access` as
`full_collection`; their contract requirements continue to govern compatibility
and setup. Query type filters are constrained locally for contract-scoped
grants; direct paths are checked against matched record types; and updates and
renames are checked against their prospective type membership before writing.

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

## Domain contracts

A type may declare an optional domain contract in an extension such as
`x-workout`. Discovery returns the extension unchanged along with its type
name and version. An adapter can then translate stable domain roles into the
collection's configured field names.

Application adapters implement their behavior through generic mdbase
operations. Revision-sensitive changes read the latest revision and submit a
conditional update. Runtime-backed notification criteria and one-shot timers
remain generic; domain planning stays in the application.

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

Applications bundle a v1 manifest and send it inline during registration.
Connect canonicalizes the manifest and identifies that exact content by its
SHA-256 digest; the reverse-domain application ID and other
presentation fields are explicitly not publisher authentication. Authorization
uses short-lived codes and PKCE; browser and native applications have no client
secret. The user approves concrete operations and the declaration-derived
record scope for one named collection.

Downloaded HTML applications use the v1 portable distribution profile described
in [portable-apps.md](portable-apps.md). They make no web-origin claim and use a
single-use OAuth device code plus PKCE and the existing per-grant P-256 key.
Their browser origin is the exact opaque value `null`, tokens and non-extractable
keys are memory-only by default. A local connector requires a matching
encrypted grant for every operation. A hosted provider instead receives a
short-lived capability bound to the exact grant, collection, operation set,
record scope, expiry, and opaque `null` origin. The SDK exposes the same
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

New authorizations use protocol 1 to encrypt each operation end to end between
an authorized application installation and the local connector. The relay sees
the operation and routing metadata but carries opaque request and response
payloads. Hosted collections use a separate provider encryption boundary. The
complete trust, key, metadata, and rollout design is in
[Encryption architecture](./encryption.md).

The Electron controller is the primary collection and permission surface. The
portal handles sign-in, pairing, account state, remote approval on trusted
private deployments, and emergency computer revocation.

## Direct local transport

Local-authority grants synchronize the application's exact approved origin to
the connector. The browser SDK can then send the existing protocol-3 envelope
to `http://127.0.0.1:28485/v1/operations`. The fixed endpoint reveals only
generic protocol readiness. It is separate from the Unix socket or Windows
pipe used for desktop administration and exposes all grantable collection
operations through the same connector handler as the relay.

The loopback listener binds only IPv4 and IPv6 loopback, validates the exact
`Host` and grant origin, returns exact-origin CORS headers, omits ambient
credentials, requires `application/mdbase-connect+json`, and bounds request
size, concurrency, execution time, and per-origin rate. Protocol-3 key proof
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
domain contract versions evolve independently. The unreleased wire contracts
all begin at v1. Future incompatible formats will use new declared versions and
ship as coordinated agent, server, and SDK releases.
