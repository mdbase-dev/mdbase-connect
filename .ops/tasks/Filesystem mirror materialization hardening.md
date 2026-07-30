---
title: Filesystem mirror materialization hardening
status: done
priority: critical
owner: codex
tags: [security, sync, filesystem, portability, testing, performance]
created_at: 2026-07-30T19:03:42+10:00
updated_at: 2026-07-30T21:28:08+10:00
type: task
---

## Context

A post-transformation review of the filesystem-mirror commits found residual
first-contact trust gaps. Authority-owned configuration could widen record
extensions, the portable mirror did not validate every snapshot invariant
before writing, and Rust and TypeScript did not share a complete physical-path
identity policy. Writable initialization preview also used a broader local file
set than mutation capture.

## Desired outcome

Make filesystem materialization fail closed before its first write, apply the
same conservative boundary in Rust and TypeScript, preserve exact document
bytes without trusting duplicated metadata, and retain the existing
architecture, mobile, and performance budgets.

## Completed work

- Remote mirrors now materialize only `.md` records. Authority-owned
  `record_extensions` cannot grant permission to create executable or
  processor-specific files.
- Snapshot pages are bound to one protocol version, snapshot identity, scope
  epoch, head cursor, and non-repeating page sequence.
- Every document-bearing record and resource uses an exact lowercase SHA-256
  revision. Record frontmatter and body must also agree with the exact
  transferred document.
- Snapshot-wide duplicate record IDs and paths that alias under case-insensitive
  or Unicode-normalizing filesystems are rejected before materialization.
- The same physical-path invariant is enforced against durable state,
  complete incremental change pages before their first write, individual
  receipt/conflict writes, and writable local capture before its first upload.
  Exact duplicate paths and case-only or Unicode-equivalent renames fail
  closed.
- Rust and TypeScript execute the same portable-path fixture corpus, including
  Windows device aliases, control characters, case collisions, and canonically
  equivalent Unicode.
- Writable initialization preview and local mutation capture now share one
  record-path filter.
- The in-memory reference authority and both hosted provider templates generate
  content-derived revisions, and writable state strips snapshot-only document
  bytes after validation.
- Snapshot validation was extracted into a focused module. A common-format
  metadata fast path and native digest injection preserve the 10,000-record
  performance gate; the narrowly added receive-only heap allowance is explicit
  and separately reported.
- The container build is pinned to engine commit
  `8f72aeb75ec98ca8ff2ae9849bd1fc107f2504f2`, and the prerelease sync-v1
  revision tightening now documents the required server-first rollout.

## Evidence

- Implementation: `bd10d21 fix(sync): close mirror materialization gaps` and
  `0864373 fix(sync): enforce physical path invariants incrementally`.
- Rust formatting, strict workspace Clippy, and the complete workspace test
  suite pass.
- Node 24 workspace typechecking and all 480 JavaScript/TypeScript tests pass.
- The architecture gate passes with 284 production files, 598 relative imports,
  11 workspace packages, no dependency cycles, and no production file above
  1,000 lines.
- The mobile mirror bundle passes at 131,091 raw bytes and 41,718 gzip bytes.
- The 10,000-record Node/portable mirror performance matrix passes its
  wall-time, heap, filesystem-I/O, and checkpoint gates with target-indexed
  incremental preflight bounded by change-page size.
- Direct product E2E, hosted sync E2E, an isolated writable-vault run over 26
  repository documents, and the disposable PostgreSQL 18 hosted-provider E2E
  all pass.

## Handoff

The reviewed snapshot and incremental materialization risks are closed on
`agent/exquisite-codebase`. Before container CI or deployment can resolve the
new engine pin, engine commit
`8f72aeb75ec98ca8ff2ae9849bd1fc107f2504f2` must be pushed to the configured
engine remote. No push was performed as part of this task. The broader
prerelease risks already recorded in the release-readiness registry remain
unchanged and are outside this task.
