---
title: First-class collection file support
status: in_progress
priority: critical
owner: codex
tags: [files, protocol, sdk, encryption, sync, mirrors, hosted, infrastructure, testing]
created_at: 2026-08-01T12:33:28+10:00
updated_at: 2026-08-01T13:01:14+10:00
type: task
---

## Context

mdbase collections may contain images, audio, video, PDFs, and other regular
files that are not records or structural resources. Connect currently omits
those files from application access, hosted storage, replication, filesystem
mirrors, and authority transfer. The prerelease phase is the right time to
introduce a coherent file model rather than widen the record extension
allowlist or push base64 payloads through the JSON operation envelope.

## Desired outcome

Make collection files first-class, safe, and easy for applications to use.
Files may remain at ordinary user-chosen collection-relative paths while their
authorization, transfer, storage, replication, selective materialization, and
conflict behavior use a separate versioned capability and protocol namespace.

Normal SDK users work with `Blob`, `File`, streams, progress, stable file
handles, and record-link helpers. They do not manage chunks, transport choice,
encryption, resumability, or authority-specific storage.

## Architectural commitments

- Classify every managed entry as a record, structural resource, or file.
- Use `file` publicly and `blob` for immutable stored bytes; an attachment is a
  relationship between a record and a file.
- Permit files at safe user-chosen paths rather than require one physical
  attachments directory.
- Exclude hidden, reserved, nested-collection, configured-exclusion,
  symlinked, non-regular, and platform-unsafe paths before file policy.
- Give files stable IDs, mutable paths, opaque conditional revisions, and exact
  SHA-256 content digests.
- Preserve one write authority and one ordered collection history across
  records, resources, and files.
- Keep JSON for transfer control and use bounded binary chunks for file data.
- Reuse grant identity while deriving domain-separated transfer keys for local
  direct and relayed traffic.
- Stage bytes before atomically committing a file mutation and change event.
- Keep application grants, collection sync inclusion, and per-device
  materialization policy independent.
- Replicate file manifests in snapshots and changes, then fetch immutable blob
  content separately and resumably.
- Store hosted file and attachment metadata and transactions with the
  Render-hosted authority in PostgreSQL, while actual immutable bytes live in
  Cloudflare R2 under opaque authority-controlled keys.
- Version file capabilities, transfer framing, and sync wire objects explicitly
  across Rust and TypeScript.

## Delivery plan

1. Freeze the architecture, threat model, namespaced grant shape, file model,
   transfer framing, sync contracts, error taxonomy, and compatibility fixtures.
2. Implement safe collection-file inventory and indexing without duplicating
   mdbase collection semantics.
3. Implement local file control, staged binary upload/download, direct loopback
   delivery, opaque relay routing, replay/idempotency, and the ergonomic SDK.
4. Implement hosted encrypted blob storage, quotas, lifecycle, garbage
   collection, backup/restore implications, and deployment infrastructure.
5. Extend snapshots, ordered changes, offline mutations, filesystem mirrors,
   selective sync, conflicts, and authority transfer.
6. Add desktop configuration, authorization copy, examples, documentation,
   fault injection, performance budgets, and complete release verification.

## Verification standard

Commit each coherent vertical slice independently. Run focused tests before
each commit and the complete repository gates after every request-path phase.
Final evidence must include Rust and TypeScript protocol fixtures, crypto
interoperability, property and path corpus tests, direct and relay E2E, hosted
PostgreSQL and object-storage E2E, mirror and authority-transfer E2E, fault
injection, restart/resume, revocation, corruption, quota races, concurrency,
performance, architecture budgets, deployment validation, and the repository's
full prescribed test suite.

## Notes

Implementation work is isolated in
`/home/calluma/projects/mdbase-connect-file-support` on
`agent/file-support`. Infrastructure work is isolated in
`/home/calluma/projects/mdbase-cloud-ops-file-support` on
`agent/file-support-infra`. Existing dirty files in the primary checkouts are
untouched.

The clean worktree baseline passes formatting, strict workspace Clippy, all 173
Rust unit and integration tests plus doc tests, Node 24 workspace typechecking,
all 731 JavaScript and TypeScript tests, architecture budgets, generated
problem-schema consistency, ops-registry validation, and beta
release-readiness validation. Four previously documented stable-release gates
remain intentionally open and are unrelated to file support.

The foundational design is recorded in `docs/files.md`. It replaces the earlier
physical attachment-root assumption with a logical file namespace and freezes
the authority, identity, revision, binary framing, encryption, staged commit,
storage, replication, selective-sync, SDK, and verification boundaries before
wire implementation.

The first executable protocol slice defines the strict
`files.v1.schema.json`, shared Rust and TypeScript models, and the bounded
`MDBF` binary frame codec. Frame headers are canonical JSON; prefixes and
payloads are length-bounded before slicing; unknown versions, kinds, flags,
fields, duplicate keys, trailing bytes, inconsistent chunk offsets, transfer
bounds, direction mismatches, and AEAD tag-length mismatches are rejected.
One checked-in golden frame is encoded byte-for-byte by both runtimes.

Focused verification passes: 18 Rust protocol tests, strict protocol Clippy,
Rust formatting, TypeScript typechecking/build, 24 Node protocol tests,
strict compilation of every canonical JSON Schema, architecture budgets, and
`git diff --check`.

The file data plane now has its own grant-bound encryption implementation in
Rust and the browser SDK. It derives a distinct HKDF-SHA-256/AES-256-GCM key
for each transfer direction, uses the chunk index as a transfer-local nonce,
authenticates the complete bounded prefix and canonical header, and does not
consume ordinary JSON operation counters. A fixed shared-secret fixture proves
byte-identical ciphertext and decryption across Rust and Web Crypto. Focused
verification now passes 21 Rust protocol tests and 86 browser SDK tests.

The hosted boundary is explicit: attachment/file rows and transactions live in
the Render-hosted PostgreSQL authority; immutable file bytes live in Cloudflare
R2. Provider-issued staging access never constitutes a collection commit.

## Handoff

Work is active. Complete transfer-key derivation and encrypted chunk fixtures,
then extend the sync schema with manifest-only file snapshot/change objects
before adding authority or storage implementation.
