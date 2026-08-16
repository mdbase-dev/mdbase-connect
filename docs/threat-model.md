# Threat model

This document defines the security claims mdbase connect intends to preserve,
the actors it does not trust, and the residual risks that remain before a
stable release. It complements [Architecture](./architecture.md) and
[Encryption](./encryption.md).

## Assets and trust zones

The principal assets are collection contents, local collection paths, account
and application identity, exact grants, OAuth credentials, connector and
application private keys, hosted data keys, change history, and revocation
state.

The system crosses five trust zones:

1. an independently hosted browser or native application;
2. the Connect control plane and transient relay;
3. a user-owned connector daemon and browser-only loopback endpoint;
4. a user-owned local collection;
5. the hosted collection provider or an optional application gateway.

TLS protects each network hop but is not the authorization boundary. For local
collections, the connector is the final policy and data authority. For hosted
collections, the provider is the final authority. The control plane may route,
authenticate an account, and issue a scoped capability, but it must not be able
to turn a broader request into an authorized collection operation.

## Adversaries

The design assumes:

- an application can be buggy, compromised, or malicious;
- an attacker can obtain an expired, revoked, replayed, or incorrectly scoped
  token;
- relay and control-plane operators or logs may be inspected;
- requests can be delayed, duplicated, reordered, interrupted, or replayed;
- a process can crash between control-plane and provider work;
- another local process running as the same user may inspect ordinary files;
- a user can accidentally copy, move, or register the wrong folder; and
- dependencies, build infrastructure, or release artifacts can be tampered
  with.

The system does not claim to protect an unlocked collection from an attacker
who fully controls the user's operating-system account, nor plaintext after an
authorized application has legitimately received it.

## Security invariants

### Least authority

Every grant identifies one application, one collection, an exact operation
set, and an exact contract or full-collection scope. The current grant is
rechecked before each bounded authority operation and each hosted file range.
Revocation cannot recall plaintext already received by an authorized
application, and one already-authorized bounded response may finish.
Application
discovery or manifest updates cannot silently broaden an existing grant.

Granting access is still a trust decision. Exact-origin binding prevents a
different site from using a capability; it does not make the approved site's
code benign. Approval surfaces therefore show the exact site and warn users to
continue only when they recognize it. Portable files receive a stronger
unverified-origin warning and proof-of-possession flow.

### Filesystem materialization

An ordinary record operation can address only a canonical collection-relative
path with a configured record extension. Configuration, type, contract,
migration, cache, hidden, excluded, symlinked, non-regular, and platform-unsafe
paths are outside that namespace. Full-document writes are parsed and validated
in a shadow collection before a crash-recoverable commit changes live files.
Remote filesystem mirrors impose a narrower, non-negotiable `.md` record
profile. Authority-owned configuration can describe other local record formats,
but it cannot grant itself permission to materialize scripts or processor-specific
files on a mirror device.

Structural resources use kind-specific namespaces. Type and contract documents
must have the corresponding frontmatter kind and configured folder; schemas
must be JSON objects below a `schemas` or `_schemas` directory; saved views must
use configured, portable, non-hidden paths. A filesystem mirror stages and
canonicalizes a complete resource snapshot before writing any part of it, then
applies the same record policy to initial and incremental changes. The portable
mirror additionally checks snapshot-wide record identity and physical-path
uniqueness, content-derived revisions, and document/metadata agreement before
it calls an injected filesystem adapter. Rust and TypeScript run one shared
cross-platform path corpus, including Windows device names and case/Unicode
aliases.

Collection files are not ordinary records or structural resources. Their
physical paths may remain anywhere inside the safe collection namespace, but
their authorization and transfer use a separately granted, versioned file
capability and binary data plane. Hidden, reserved, nested, excluded,
symlinked, non-regular, and platform-unsafe paths remain outside that namespace.
Transfers use bounded chunks, size and quota controls, opaque content handling,
and non-executable materialization semantics. Adding a binary extension to the
record allowlist is not a file-transfer design. See
[Collection files](./files.md).

### Local privacy

Absolute collection paths, record contents, operation arguments, results, and
runtime event payloads do not enter control-plane persistence. Relay operation
payloads are encrypted between the application and connector. The relay can
observe routing metadata, timing, and ciphertext size.

Connector identity private material is stored in the operating system's secret
store. Legacy filesystem identity material is migrated only after a verified
secret-store round trip and then removed. Browser application keys are
non-extractable and counter allocation is atomic across tabs and survives a
browser restart. The native CLI is a distinct portable application: its stable
installation identity, per-collection refresh credentials, provider capability,
and grant signing key also live in the operating-system secret store. Its local
registry contains only grant identifiers, permissions, endpoints, public keys,
and expiry metadata.

### Hosted confidentiality and integrity

Hosted Markdown and resource state use per-collection data keys wrapped by the
provider key hierarchy. The provider validates capability proofs, epochs,
request freshness, replay state, quotas, and the exact grant before a
transaction commits. Database compromise without the provider master key is
within the exact-document encryption-at-rest claim; compromise of the live
provider or its active master key is not.

The selected hosted architecture deliberately persists a provider-readable
semantic projection derived by mdbase-rs. Database, replica, snapshot, and backup
readers can learn canonical paths, file facts, types, persisted/effective
frontmatter, diagnostics, relationship edges, structural body facts, and value
frequency. They must not receive exact Markdown or body prose from the projection.
Logs and telemetry may record bounded counts and timing, never projection payloads.

Snapshot cursors also make closed query metadata readable. Obsidian Base cursors
reveal parsed formulas, filters, property references, renderer options,
ordering/grouping choices, a pinned operation clock, and any projected `this.file`
context. They do not reveal exact `.base` formatting, exact record Markdown, or
body prose. Cursor ownership, scope epoch, operation kind, semantic-plan digest,
single-use rotation, and hard expiry prevent cross-capability or cross-surface use.

Lost-response query receipts remain application-encrypted because their result may
contain exact Markdown or body prose. Their visible metadata includes request and
replica identity, lifetime, encoding, and ciphertext length. Beneficial payloads are
bounded-compressed before encryption to limit WAL and transaction lifetime; this
leaks compressed length in place of uncompressed length but does not mix an
unauthorized caller-controlled reflection with secrets. AEAD verification precedes
bounded decompression, and legacy `json-v1` remains readable during rollout.

Projection rows are non-authoritative and revision-, semantic-catalog-, engine-,
format-, and generation-bound. A current projection may narrow candidate selection and
authorization classification. A stale, absent, ambiguous, corrupt, or unverifiable
projection forces bounded canonical mdbase-rs classification and fails closed if
that cannot complete. Queries union current projection matches with stale/absent
records so optimization cannot create false negatives.
Currentness also requires equality between the application-set expected row digest
and the trigger-maintained observed digest. The envelope binds record/collection
identity, exact revision and sequence, temporal start, catalog/engine/format and
generation, path, types, file facts, completeness, semantic JSON, structure, and
byte accounting. Candidate SQL compares only the stored digests; it does not detoast
and rehash every projection at read time. This is a corruption/substitution guard
inside the trusted database model, not a MAC against a malicious database operator.
Candidate B writers use an all-zero expected digest solely as a trigger marker for
same-tuple binding; the trigger replaces it before storage. This removes a redundant
projection update and its dead tuple, but deliberately adds no protection against a
database actor who can submit arbitrary writes. Direct unmarked changes invalidate
the row, advance the generation integrity epoch, and require a complete verified
scan before SQL-only proofs can be reused.
For scoped queries, that safety union can contain records later excluded by
canonical classification. Client-visible budget errors therefore disclose only
that the configured threshold was crossed (`observed = limit + 1`), never the raw
aggregate row, exact-document, or plaintext-byte count. Exact counts remain
operator-only telemetry.

Outgoing relationship edges are readable derived state. mdbase-rs owns link,
embed, tag, anchor, label, relative-target, and ambiguity semantics; the provider
persists only the bounded target/kind/anchor/relative/resolution graph and derives
backlinks from indexed inverse lookup. Body labels, Markdown destination titles,
malformed source tails, and complete source spellings are redacted; frontmatter
occurrences remain readable because frontmatter itself is projected. Body-dependent
computed values are non-projectable and force exact fallback. A write atomically
binds ciphertext, revision, projection, and relationship state.
This target is not yet enabled for production traffic, so current production
security promises do not change until the final rollout approval.

### Revocation and recovery

Pause and revocation fail closed at the authority. Control-plane revocation
atomically disables the grant, tokens, and derived replica, then records
provider cleanup in a durable retry queue. A provider outage cannot turn failed
cleanup into a successful-but-forgotten revocation.

Authority transfer uses explicit states, epochs, fencing, and recovery. A
local folder cannot simultaneously act as a filesystem authority and hosted
mirror, and a process-wide lease prevents multiple mirror writers.

### Protocol and release integrity

Rust and TypeScript share versioned wire contracts and compatibility fixtures.
Malformed or unsupported input fails with a structured error. Images are built
once for a source commit with SBOM and provenance attestations, then promoted
by digest. Desktop artifacts use platform signing where configured and are
explicitly labelled as unsigned beta previews otherwise.

## Abuse cases and controls

| Abuse case | Primary controls |
| --- | --- |
| Application requests more data than approved | Grant planning intersection; exact authority-side recheck; contract-scoped filtering |
| Stolen or replayed request | Short-lived scoped credentials; proof validation; durable monotonic counters and replay state |
| Copied hosted CLI bearer or refresh token | Per-collection grant scope; opaque-origin binding; grant-key proof on operations and refresh; authority-side revocation |
| Relay reads collection contents | End-to-end encrypted operation envelopes; no plaintext payload persistence |
| Control plane leaks local location | Connector-generated opaque collection identity; schemas and logs exclude absolute paths |
| Crash loses revocation | Atomic local disable plus durable cleanup outbox and recovery worker |
| Two authorities write one collection | Explicit authority lifecycle, epoch fencing, folder role marker, and mirror lease |
| Copied folder aliases an authority | Duplicate identity detection and explicit register-copy flow |
| Provider database is copied | Exact Markdown/body prose remain envelope-encrypted; readable projection and relationship leakage is explicitly inventoried and access-controlled |
| Stale or corrupt projection widens a scoped grant | Version-bound currentness; canonical mdbase-rs fallback; fail-closed authorization; transaction-time grant/catalog/revision revalidation |
| Projection candidate plan misses an authorized semantic match | Closed versioned IR; no-false-negative conformance; stale/absent union; canonical residual evaluation |
| Obsidian Base expression exhausts CPU, stack, graph, or retained rows | AST work counter, bounded growable evaluator stack, one-hop graph completion proof, candidate/edge/group/byte/memory/time budgets, typed failure |
| Malicious dependency or artifact | Frozen lockfiles, automated dependency review, audit gate, pinned Actions, provenance, signatures, checksums |
| UI hides or confuses a security decision | Concrete permission review, semantic browser checks, keyboard navigation, and reduced-motion coverage |
| Authorized application targets scripts or control files | Canonical record namespace, extension allowlist, resource-kind binding, shadow validation, symlink and regular-file checks |
| Hosted snapshot disguises an arbitrary file as a resource | Staged canonical resource comparison before live mirror materialization |

## Logging and data minimization

Logs may contain opaque IDs, status codes, durations, cursor positions, and
bounded sizes. They must not contain access or refresh tokens, private keys,
proofs, operation plaintext, record content, notification payloads, absolute
local paths, or secret-store values. New diagnostics should start from an
allowlist of fields instead of serializing request or database objects.

## Residual risks before stable

The beta deliberately accepts several risks that require production
infrastructure or publisher accounts rather than another local refactor.
Signed application identity, connector-key continuity, and the managed key
service plus staging rotation drill are complete. The following remain
stable-release gates:

- verified encrypted backup, restoration, key recovery, and deletion behavior;
  and
- canonical platform signing and notarization.

These are machine-readable gates in
[`config/release-readiness.json`](../config/release-readiness.json).
`pnpm check:release-readiness` validates and reports them during beta;
`pnpm check:release-readiness -- --stable` fails until every gate is marked
complete with durable evidence.

An independent security audit, including the custom cryptographic protocol and
implementation, remains planned separately. It is not a stable-release gate;
release notes and security claims must state whether that audit has occurred.
The internal, source-mapped preparation package is
[Security audit preparation](./security-audit-package.md); it is not an
independent audit or certification.

## Verification map

- policy and state machines: focused unit and property tests;
- SQLite/PostgreSQL behavior: repository and migration integration tests;
- browser key behavior: real Chromium persistent-profile tests;
- user-facing semantics: portal and desktop accessibility browser tests;
- retry and recovery: provider outage and revocation fault injection;
- complete boundaries: local, relay, sync, hosted-provider, desktop, upgrade,
  and Docker-backed end-to-end suites.

Security fixes receive a regression test at the narrowest reliable layer and
the affected end-to-end boundary before release.
