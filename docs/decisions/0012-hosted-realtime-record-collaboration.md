# ADR 0012: Hosted real-time collaboration materializes one exact Markdown body

- Status: accepted for development-only prototypes
- Date: 2026-08-24

## Context

Collection sharing gives each person and application an independently bounded
replica, but conventional conditional writes do not support simultaneous edits
to one record. The first real-time increment targets hosted Editor sessions
without changing ordinary Markdown records, mirrors, watches, or clients that do
not request collaboration.

The Editor currently owns a derived draft: for heading-titled notes it removes
the leading heading, edits the remainder, and reconstructs the body on save.
That projection is unsuitable for a CRDT authority because whitespace, headings,
and line endings can change. The hosted provider already commits encrypted
record state, immutable versions, collection changes, notification outbox rows,
and durable receipts transactionally, but it has no CRDT state, room transport,
or per-record collaboration boundary.

A direct smoke test selected Yjs 13.6.32 and Yrs 0.26.0. Yrs 0.27.2 through
0.27.4 do not compile with the repository's current stable Rust toolchain because
they use an unsupported `if let` guard.

## Decision

### The public record remains ordinary Markdown

Yjs/Yrs is an implementation profile, never the public record format. The first
profile is `markdown-body-yjs-v13`, profile contract version 1. It contains
exactly one root, `Y.Text("body")`.

The materialization invariant is:

```text
UTF8(Y.Text("body").toString()) == UTF8(RecordDocument.body)
```

No Unicode normalization or Editor-specific heading projection is permitted.
This invariant does **not** claim that the complete frontmatter-bearing document
is byte-identical: frontmatter, path, title properties, files, and other record
operations remain on the conventional conditional-write path. Materialization
must retain the current frontmatter bytes and use the ordinary exact-document
update path. The semantic `body` convenience field is prohibited because its
canonical serializer adds a trailing newline and can diverge from transient
Y.Text states. While the room is
active, the Editor displays the complete body, including a heading-derived
title, and makes the separate heading-title control read-only.

Profile v1 admits Unicode scalar values and LF line endings. It rejects NUL,
CRLF, mixed line endings, and lone CR before room admission. JavaScript also
rejects unpaired UTF-16 surrogates. This explicit restriction avoids a
collaboration-only normalization rule and may broaden only after exact
CodeMirror, Yjs, Yrs, materialization, reload, and frontmatter-operation proofs.

Yrs uses `OffsetKind::Utf16`, matching Yjs and CodeMirror positions. Provider-
origin ordinary body changes are translated to bounded textual deltas at Unicode
scalar boundaries and then converted to UTF-16 offsets; they are not implemented
as wholesale Y.Text replacement.

### A provider-neutral core owns profile semantics

`crates/connect-collaboration` owns only profile validation, Yrs state/update
handling, state vectors, compact full-state updates, root checks, materialized
body limits, and provider-origin textual deltas. It owns no SQL, encryption,
authorization, tickets, WebSockets, or hosted-provider types. A later local
authority may reuse this core while retaining its own final authorization and
persistence boundary.

`packages/collaboration` owns the corresponding lazy-loadable Yjs profile
adapter. Yjs is pinned exactly to 13.6.32 and Yrs exactly to 0.26.0. Cross-runtime
binary fixtures, state vectors, deletions, concurrent updates, compacted state,
and runtime versions are committed and digest-pinned.

### Collaboration is a distinct optional authority capability

Collaboration will not be added to `CollectionOperation` or inferred from
`update`. Room access requires a separately versioned exact replica capability;
read-only access also requires ordinary record read authority, and durable room
updates additionally require ordinary record update authority. Mirrors and
contract-scoped grants are excluded initially.

Existing manifest v1, semantic capability v1, authorization bindings, replicas,
and clients remain valid. A later protocol RFC must add an independently
negotiated collaboration request/evidence and signed binding without replacing
v1 in place. Unsupported authorities remove only the optional collaboration
capability and leave conventional editing available.

Existing membership-policy rows remain collaboration-disabled. A future policy
revision must explicitly adopt a collaboration ceiling before any member can
mint such a replica.

### Durable CRDT state belongs to the collection authority

Yrs snapshots and updates are encrypted auxiliary authority state. Every
acknowledged update batch must atomically commit CRDT state, materialized record,
normal record version, collection change, collaboration sequence, and receipt.
Broadcast occurs only after commit. Ordinary writes to an active room use the
same record serialization boundary.

Room identity is `(collection_id, record_id, collaboration_epoch, profile)`.
Paths are not identities. Old-epoch updates are rejected rather than merged.
Authority transfer, deliberate rebuild, incompatible profile change, and repair
advance the epoch.

The Connect control plane resolves authorization and lifecycle but never
receives record content, Yjs updates, selections, or room awareness.

## Development gates

No public capability, provider transport, or Editor rollout may proceed until
executable Phase 0 proofs establish all of the following:

1. bidirectional Yjs/Yrs v1 update and state-vector compatibility, including
   deletion, reordering, duplication, Unicode, and compacted snapshots;
2. convergence of provider-origin textual deltas with an offline browser update;
3. exact supported body round-trip through CodeMirror and both runtimes;
4. real PostgreSQL crash recovery at every proposed persistence boundary, with
   no pre-commit acknowledgement or broadcast;
5. the ordinary exact-document mutation path accepts expected transient body
   states while preserving the current frontmatter bytes; semantic `body`
   serialization is never used for room materialization;
6. malformed roots and bounded update/body limits fail without poisoning live
   room state; and
7. existing non-collaborative clients and manifests pass unchanged.

The crash proof must kill and restart a child process against persistent
PostgreSQL. Inspecting an open transaction or relying only on rollback tests is
not sufficient.

## Consequences

- Heading-derived notes look different while collaborating because the actual
  heading is visible and collaboratively owned.
- Records containing a carriage return are initially collaboration-unavailable
  but remain conventionally editable.
- Yjs is absent from the ordinary SDK path and loaded only by the optional
  profile adapter.
- Snapshot compaction preserves enough Yrs state to synchronize an old state
  vector; it does not imply an epoch reset.
- Presence is ephemeral, server-sanitized, and never record history.
- Durable browser persistence, local-authority rooms, collaborative frontmatter,
  files, contract scope, and migration of live CRDT history remain separate
  gates.
