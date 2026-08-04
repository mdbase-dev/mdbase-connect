---
title: Beta hardening 02 - SQLite migrations and recovery
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 2
phase: 1
depends_on: [Beta hardening 01 - contracts and baseline]
tags: [beta, sqlite, migrations, backup, recovery]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T18:50:05+10:00
type: task
---

# Beta hardening 02 - SQLite migrations and recovery

## Outcome

Replace ad hoc local registry schema setup with numbered, crash-resumable
migrations, consistent restricted backups, integrity classification, explicit
restore/rebuild UX, and historical beta.28 fixtures.

## Exit gate

New and upgraded beta.28 registries converge; every injected interruption
resumes idempotently; clean and WAL-active backups restore; corruption is
preserved and diagnosed without touching canonical Markdown.

## Delivery

- Replaced ad hoc schema setup with a numbered, checksummed migration ledger
  and `PRAGMA user_version` boundary.
- Added exact beta.28 shape recognition, transactional migration, fail-closed
  handling for unsupported/future/tampered schemas, and distinct busy/corrupt/
  incompatible/migration problem codes.
- Added online WAL-safe backups with restricted permissions, SHA-256 integrity,
  HMAC-authenticated metadata, durable writes, diagnostics, verified restore to
  a new path, and a conservative index-only rebuild operation.
- Documented the supported schema matrix and recovery contract in
  `docs/registry-schema-support.md`.

## Evidence

- `cargo test -p mdbase-connect-core`: 95 passed, including beta.28 data
  preservation, new/upgraded schema convergence, three reopens through the
  public registry boundary, WAL-active restore, all injected migration fault
  points, corrupt/future/tampered/busy classification, backup tamper rejection,
  permission checks, and authorization/receipt-preserving index rebuild.
- `MDBASE_CONNECT_ENV=test MDBASE_CONNECT_SECRET_BACKEND=insecure-test-file cargo test --workspace`: green.
- `cargo clippy --workspace --all-targets -- -D warnings`: green.
- `cargo fmt --all -- --check` and `git diff --check`: green.
- Node 24 workspace build, typecheck, and test suites: green; client compile
  spikes green.
- `pnpm e2e` local daemon/system path: green after the migration boundary.

## Exit-gate decision

Green. The supported beta.28 registry converges without data loss, recovery is
idempotent at every injected interruption, both clean/new and active-WAL backup
paths restore, and corrupt inputs remain preserved and explicitly diagnosed.
