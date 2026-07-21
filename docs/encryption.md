# Encryption architecture

Status: encrypted relay implemented; hosted encryption remains a design

## Purpose

mdbase connect supports several data locations with different trust boundaries.
Encryption should give each location a clear, accurate promise while preserving
the usefulness of ordinary Markdown.

The intended product guarantees are:

- a relay-only collection keeps its record payloads on the user's devices and
  sends them through Connect as end-to-end encrypted envelopes;
- a standard hosted collection is encrypted at rest, while its hosted provider
  can decrypt records to perform mdbase operations;
- a future private hosted collection stores client-encrypted records and
  performs querying on authorized clients;
- a local filesystem collection remains ordinary Markdown and relies on device
  and volume encryption for protection at rest.

These are separate guarantees. The interface should name the data location and
its practical consequences instead of presenting a single encrypted/unencrypted
switch.

## Current state

New SDK authorizations use encrypted relay protocol 3 by default. The browser
and connector derive separate request and response keys with P-256 ECDH and
HKDF-SHA-256, then authenticate payloads and their routing context with
AES-256-GCM. The control plane receives the operation name, grant and routing
identifiers, counter, timing, sizes, and ciphertext. It cannot decode operation
inputs, mdbase results, or connector diagnostics.

The connector persists replay state before executing an operation. Duplicate
request IDs, non-increasing counters, stale grant bindings, altered metadata,
altered ciphertext, and plaintext requests for encrypted grants are rejected.
Policy changes rotate the binding epoch and key ID. The SDK refreshes that
binding without falling back to plaintext.

Protocol 2 remains available only when an SDK explicitly requests the legacy
mode. It provides transport encryption and allows the control plane to read
relayed payloads in memory. It is a migration path and does not carry the
relay-only privacy promise.

The TypeScript/Rust end-to-end suite crosses both cryptographic
implementations and exercises tampering, replay, scope, pause, revocation, and
downgrade behavior. Connector identity material currently lives in a mode-0600
agent state file. Moving it into platform-protected storage, verifying first
contact, and auditing logs remain public-release gates.

Local Markdown files are also plaintext from mdbase's perspective. Operating
system full-disk encryption, encrypted home directories, and device access
controls protect those files without changing their format.

## Protection modes

| Mode | Payload storage | Who can decrypt record content | Query location |
| --- | --- | --- | --- |
| Local only | User filesystem | User device and local applications | User device |
| Relay only | User filesystem; transient ciphertext in relay | Authorized application and connector | Connector |
| Standard hosted | Encrypted hosted store and authorized replicas | Hosted provider and authorized applications | Hosted provider |
| Private hosted | Client-encrypted hosted store and authorized replicas | Devices holding collection keys | Authorized client |

Relay encryption and hosted encryption solve different problems. Relay
encryption removes the control plane from the record-content trust boundary.
Standard hosted encryption protects stored data while preserving server-side
mdbase behavior. Private hosted encryption removes the hosted provider from the
content trust boundary and moves collection behavior to clients.

## Relay-only encryption

### Security boundary

For a relay-only collection, the encrypted channel terminates at:

- the authorized application instance; and
- the user's local connector.

The control plane authenticates the request, applies its grant check, enforces
rate limits, and routes an opaque payload. The connector decrypts the request,
checks its locally cached exact grant, performs the mdbase operation, encrypts
the result, and returns it through the relay.

The control plane may observe:

- account, application, connector, grant, and collection identifiers;
- the requested operation, unless a later protocol moves that check entirely
  to the connector;
- request and response times, sizes, success at the routing layer, and network
  addresses;
- connection state, pause state, revocation, and rate-limit activity.

It cannot read encrypted operation inputs or connector results. This includes
record frontmatter, Markdown bodies, query expressions, validation diagnostics,
and returned records.

The authorized application receives plaintext by design. Application code,
browser extensions, injected scripts, and the application vendor remain inside
that application's trust boundary. Relay encryption does not constrain what an
authorized application does after decryption.

### Grant-bound keys

Each connector installation has long-lived P-256 key-agreement material. Its
private key is stored in the agent state directory with owner-only file
permissions on Unix; its public key is registered when the connector
synchronizes. Platform keystore integration remains to be implemented.

Each browser application installation creates P-256 material for an
authorization. The SDK reimports the private key as non-extractable and stores
its `CryptoKey` plus an atomic message counter in origin-scoped IndexedDB.
Native application key storage remains to be implemented with platform
keystores.

The authorization request carries the application's public key. Approval binds
these values together:

- protocol and encryption-suite version;
- grant and application identity;
- connector and collection identity;
- application and connector public keys;
- operations and contract scope;
- creation time and revocation state.

The connector and application derive directional request and response keys from
their shared secret with a standard key-derivation function. Binding grant,
collection, application, connector, protocol, and key identifiers into the
derivation prevents a key from being reused in another authorization context.

A grant gets fresh application key material when it is reauthorized. Revocation
removes the connector's active grant key and blocks relay routing. Losing an
application key requires authorization again; it never puts the underlying
local collection at risk.

### Active control-plane attacks

Server-mediated public-key discovery protects against passive observation,
payload logging, database disclosure, and an honest-but-curious control plane.
An actively malicious control plane could try to replace public keys during the
first authorization and become a man in the middle.

The protocol should make that boundary explicit. Increasing levels of active
server resistance are possible:

1. **Grant binding and key continuity.** The connector signs the approved key
   binding, and applications pin the connector identity after first use. Later
   substitutions become visible.
2. **Key transparency.** Connector identity changes appear in an append-only,
   auditable account log.
3. **User verification.** A short authentication string or QR flow confirms a
   first connection through a path outside the relay.

The first public release should choose and document one of these levels after a
focused threat-model review. It must not describe server-mediated first contact
as protection against an actively malicious server.

### Encrypted envelope

Every relayed application request and connector response uses an authenticated
encryption envelope containing visible routing metadata and ciphertext. The
authenticated associated data binds at least:

- envelope and Connect protocol versions;
- grant, application, connector, and collection IDs;
- request ID and direction;
- operation name and scope epoch;
- key ID and monotonically increasing message counter.

The encrypted body contains the canonical operation input or response. A unique
nonce is derived or generated according to the selected audited construction.
Authentication failure, reused counters under another request, wrong direction,
and stale keys are rejected before decoding the payload. Authenticated counters
may arrive out of order within a bounded window. An identical request ID and
envelope returns its completed encrypted response receipt.

Server-generated authorization and routing errors remain visible protocol
errors. Connector-generated mdbase results and diagnostics stay inside the
encrypted response.

Protocol 3 fixes the interoperable profile to P-256 ECDH, HKDF-SHA-256, and
AES-256-GCM. A 96-bit nonce contains a zero 32-bit prefix and the grant's
monotonic unsigned 64-bit counter. Canonical context strings and envelope
schemas are shared across Rust and TypeScript and covered by cross-runtime
tests. An external cryptographic review is still required before a public
security claim.

### Downgrade behavior

Encryption capability is bound into authorization and key derivation. An
encrypted grant cannot fall back silently to a plaintext relay. A connector or
application that lacks the required protocol returns an upgrade-required error
before any record operation is sent.

Protocol 2 remains identifiable as transport-encrypted relay traffic during
private migration. A public relay-only promise should begin only when both ends
require the end-to-end encrypted protocol.

### Relay handling

The relay treats encrypted bodies as bounded opaque bytes. It records byte
counts and routing outcomes and excludes ciphertext, nonces, public keys,
authorization codes, and cryptographic error details from ordinary logs.

Payloads remain in memory only for request routing. Queueing, retry, and
backpressure use request IDs and sizes. The service does not persist encrypted
payloads as an incidental message archive.

### Direct loopback delivery

The same protocol-3 request and response envelopes are used on the connector's
browser-only loopback service. This preserves grant binding, key proof, replay
handling, and response authentication while avoiding control-plane payload
delivery for same-computer applications. Exact-origin CORS, loopback `Host`
validation, non-simple content types, no cookies, and bounded resources harden
the HTTP boundary; none replace cryptographic authorization.

The connector persists completed encrypted response receipts locally, keyed by
grant key, request ID, counter, and request fingerprint. If a direct response
is lost, relay fallback presents the exact same request and receives the same
ciphertext without repeating the collection operation. Receipts contain
ciphertext rather than plaintext and are pruned with the bounded replay window.

## Standard hosted encryption

A standard hosted collection deliberately gives its provider access to record
content so applications can query and validate without downloading the whole
collection. Encryption at rest protects database files, snapshots, backups,
and copied storage media. It does not protect against a compromised hosted
provider while the collection key is available to that provider.

### Infrastructure encryption

Managed-database volume encryption and encrypted backups form the minimum
baseline. Their keys are controlled separately from database credentials and
follow documented rotation and recovery procedures.

### Collection envelope encryption

Each hosted collection receives a random data-encryption key. A key-encryption
key held by a managed key service wraps that collection key. PostgreSQL stores
the wrapped collection key and encrypted content; the key service controls
unwrapping and records its use.

Each canonical document and retained version is authenticated with its
collection ID, record ID, revision, and format version. Nonces are unique per
key and record version. Key rotation creates a new key version and re-encrypts
content incrementally while old versions remain readable during the migration.

The provider unwraps a collection key only while serving authorized work and
keeps plaintext and unwrapped keys out of logs, crash reports, and durable
caches. Memory clearing has platform limits, so operational isolation and
short-lived provider processes remain part of the protection.

### Hosted metadata

The hosted design records which metadata remains visible. A practical first
version can leave tenant, collection, record ID, revision, sequence, size,
deletion state, and contract-routing metadata in plaintext. Paths can be
encrypted while a keyed path token enforces uniqueness.

Frontmatter values, bodies, query source, validation results, and retained
document versions should remain encrypted at rest. Plaintext JSONB copies or
search indexes would weaken the database-dump protection. The first hosted
provider can decrypt scoped candidate records and evaluate queries through
`mdbase-rs`; later indexes need their own documented leakage analysis.

The encryption design and the hosted storage interface in
[Hosted collections and sync](./sync.md) must be developed together. Revisions,
version retention, transaction boundaries, and exports all cross this boundary.

## Private hosted collections

A private hosted collection encrypts record documents before upload. mdbase
Cloud stores ciphertext, stable record IDs, ordering information, and the
replication log. An authorized client downloads, decrypts, validates, and
queries its local projection.

This mode changes the available product behavior:

- hosted query and validation move to clients;
- browser applications need local encrypted caches and collection keys;
- web push can announce opaque changes and cannot include readable record
  content;
- account recovery cannot recover a lost collection key without a user-held
  recovery mechanism;
- server-side previews, indexing, automation, and content-based abuse controls
  are unavailable.

Contract-scoped sharing also needs additional design. A provider cannot derive
record type membership from encrypted frontmatter. Possible approaches expose
signed scope labels, use separate keys for contract projections, or require
full-collection clients. Each approach leaks different metadata and becomes
complex for records matching multiple types.

Private hosted collections should therefore follow the standard hosted and
relay-encryption work. Their protocol can reuse stable IDs, mutations, cursors,
and ciphertext delivery from sync, while their key distribution and scoped
projection require a dedicated design and recovery story.

## Local files and device caches

### Filesystem collections and mirrors

mdbase Markdown files remain readable by Obsidian, editors, Git, search tools,
and user scripts. Per-file application encryption would remove that
interoperability. Full-disk or encrypted-volume protection is the normal local
at-rest boundary.

Connect can warn when the operating system reports that protected storage is
unavailable, while leaving device-security policy with the user. A future
encrypted mirror would be a distinct cache format rather than an ordinary
Markdown mirror.

### Mobile and application caches

Offline caches contain decrypted record content and pending mutations. They use
platform database encryption with keys protected by the device keystore. Cache,
mutation queue, conflict state, and sync credentials share the same device-lock
and backup policy.

An application clears decrypted in-memory state when the operating system locks
or removes the session where platform APIs permit it. Revocation stops new
network access; local cache retention or removal follows an explicit user and
application policy.

Browser storage has a weaker boundary because scripts running in the authorized
origin can use origin-held keys. Non-extractable keys reduce accidental export
and do not protect against malicious or injected code executing in that origin.

## Threat coverage

| Threat | Primary protection | Remaining exposure |
| --- | --- | --- |
| Network observer | TLS for all modes; end-to-end payload encryption for relay | Timing, destination, and approximate sizes |
| Control-plane payload logging or database disclosure | End-to-end relay encryption | Routing and grant metadata |
| Hosted database or backup copy | Infrastructure and collection envelope encryption | Declared plaintext metadata |
| Compromised hosted provider process | Private hosted mode | Access patterns and replication metadata |
| Stolen locked device | Full-disk, cache encryption, and OS keystore | Platform-dependent metadata |
| Compromised authorized application or browser origin | Application review, narrow grants, and revocation | Data the application is authorized to decrypt |
| Compromised local connector or unlocked account | Device security and local activity review | Accessible local collections and active grants |
| Lost private-cloud key | User recovery key or another authorized device | Permanent data loss without recovery material |

Encryption does not replace contract scopes, exact operation grants, revision
checks, local pause, activity history, rate limits, or revocation. Those controls
remain effective before and after decryption at their respective endpoints.

## Key lifecycle

Keys have distinct lifecycles:

- connector identity keys are created at installation, protected locally,
  rotated through an explicit re-pairing or continuity flow, and removed when
  the computer is revoked;
- per-grant application keys are created during authorization, rotated on
  reauthorization or policy change, and discarded on disconnect or revocation;
- standard hosted collection keys are generated by the provider, wrapped by a
  managed key service, versioned, backed up through the wrapped form, and
  destroyed according to collection deletion policy;
- private hosted collection keys are generated and wrapped on user devices,
  shared only with approved device/application keys, and covered by an explicit
  recovery procedure.

Key identifiers and versions are durable metadata. Raw keys, shared secrets,
and decrypted recovery material never enter audit events.

## Implementation state and remaining sequence

### Implemented: relay protocol and fixtures

- protocol 3 request, response, grant-binding, and schema definitions;
- Rust connector identity, derivation, authenticated encryption, durable replay
  state, exact local policy enforcement, and encrypted responses;
- browser non-extractable keys, atomic counters, encrypted operations, binding
  refresh, and fail-closed behavior;
- opaque relay routing and cross-runtime end-to-end coverage.

### Next: release security work

- platform-protected connector identity and native application key storage;
- first-contact connector identity verification or key transparency;
- browser restart and multi-tab integration tests using real IndexedDB;
- independent protocol review and systematic log, trace, and crash-path audit.

### Then: hosted envelope encryption

- integrate collection-key wrapping with the hosted Rust provider;
- encrypt current documents, versions, paths where selected, and backups;
- document visible metadata and query-index leakage;
- implement rotation, restore, export, deletion, and key-service outage paths.

### Later: private hosted prototype

- create a full-collection client-encrypted sync prototype;
- test recovery and a second-device key grant;
- measure mobile download, local query, and cache costs;
- resolve contract-scoped key distribution before offering third-party app
  access.

## Acceptance criteria for encrypted relay

The relay-only encryption milestone is complete when:

1. An interceptor at the control plane cannot recover a known frontmatter
   value, Markdown body, query expression, diagnostic, or result.
2. Captured ciphertext cannot be replayed under another request, direction,
   grant, collection, application, or connector.
3. Modified metadata or ciphertext fails authentication at the endpoint.
4. Restarted applications and connectors recover only through protected key
   storage or deliberate reauthorization.
5. Revocation prevents routing and causes both endpoints to retire the grant
   keys.
6. An encrypted grant refuses plaintext protocol downgrade.
7. Relay logs, traces, metrics, and crash paths contain no operation payload or
   cryptographic secret.
8. Existing operation, scope, conflict, pause, and activity behavior remains
   correct inside the encrypted channel.
9. The UI accurately says that the relay cannot read record contents and names
   the metadata and endpoint trust that remain.

## Decisions still open

- first-contact authentication against an actively malicious control plane;
- key rotation intervals and message limits;
- visible relay metadata, including whether operation names remain visible;
- plaintext metadata and query-index leakage for standard hosted collections;
- key-service availability and disaster-recovery procedure;
- private-hosted recovery and contract-scoped key distribution.

The relay guarantee can be implemented independently of hosted sync. Hosted
storage and private-hosted encryption then build on the same explicit key,
metadata, and protocol-version boundaries.
