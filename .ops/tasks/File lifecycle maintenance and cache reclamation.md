---
title: File lifecycle maintenance and cache reclamation
status: done
priority: critical
owner: codex
tags: [files, hosted, mirror, selective-sync, maintenance, reliability]
created_at: 2026-08-01T21:04:40+10:00
updated_at: 2026-08-01T21:20:10+10:00
type: task
---

## Context

Three remaining lifecycle gaps can cause excluded content to materialize or
storage to grow indefinitely: excluded-folder matching does not use portable
path identity, ordinary hosted uploads expire only when touched, and
content-addressed mirror blob caches have no reclamation pass.

## Desired outcome

Keep Rust and TypeScript mirror selection semantics identical, recover
abandoned hosted transfers through bounded durable maintenance that is safe
against commit races, and prune mirror caches from an explicit durable
reference set without weakening crash recovery.

## Plan

1. Normalize folder and candidate paths before component-aware exclusion checks
   in both mirror implementations, with case and Unicode alias tests.
2. Add bounded ordinary-transfer recovery to hosted maintenance, using durable
   cleanup intent and adversarial commit/expiry coverage.
3. Add a cache-pruning contract and implementations that retain current,
   pending, and recovery-plan digests under the mirror lease.
4. Run focused and full verification and record exact evidence here.

## Handoff

Completed in `3447ec8`, `fa8f51a`, `970ac2d`, `d711f7d`, and `b77125d`.

Rust and TypeScript now compare excluded folders and candidate paths through
the same case-folded, NFC-normalized portable identity while retaining
component-aware prefix matching. Case, Unicode-equivalence, and prefix-neighbor
tests cover both implementations.

Hosted maintenance now claims bounded expired transfers with `FOR UPDATE SKIP
LOCKED`, atomically records durable object-deletion intent, retries multipart
cleanup through an explicit checkpoint, and lets the existing reference-safe
deletion queue survive object-store outages. Request-time abort and expiry use
the same maintenance boundary. The adversarial suite covers maintenance and
commit as opposing winners, late publication, abandoned open uploads, and an
injected deletion failure.

Rust and TypeScript mirrors prune complete unreferenced content-addressed blobs
only after a successful durable sync and while holding the mirror lease. The
retained set includes current files, TypeScript pending file mutations, and
Rust durable rebuild plans. Temporary and malformed cache entries are outside
the complete-blob namespace and are not removed by this pass.

Verification evidence:

- `cargo fmt --all -- --check`: passed;
- `cargo clippy --workspace --all-targets -- -D warnings`: passed;
- `cargo test --workspace`: passed;
- `pnpm check:architecture`: passed after extracting hosted maintenance from
  the upload request module;
- `pnpm typecheck`: passed;
- `pnpm test`: sync and all other package suites passed; one editor loading
  timing test failed once, then its isolated rerun and the complete 230-test
  editor suite passed;
- `pnpm e2e:files:adversarial`: passed with the expanded maintenance matrix;
- `pnpm e2e:files`: passed against disposable PostgreSQL and S3-compatible
  object storage;
- `pnpm e2e`: builds passed, then reproduced the existing external page drift
  waiting for `Use a local folder`;
- `pnpm e2e:sync`: exposed that the TypeScript reference server has no
  `files/snapshot` route required by the current `HttpSyncTransport`; it fails
  before cache pruning and is separate follow-up work.
