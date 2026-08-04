---
title: Beta hardening 01 - contracts and baseline
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 1
phase: 0
depends_on: []
tags: [beta, sdk, protocol, contracts, baseline]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T18:33:40+10:00
type: task
---

# Beta hardening 01 - contracts and baseline

## Outcome

Freeze the mutation state machine, generated mutator catalogue, independent
version axes, consumer-tested public SDK, canonical fingerprint encoding,
deployment switch, artifact inventory, and complete green baseline.

## Exit gate

Every Phase 0 artifact is reviewable and the disposable compile fixtures for
Editor, Workouts, Pickle, and TaskNotes prove the frozen API before storage or
protocol implementation begins.

## Notes

Beta.31 already provides a canonical collection-operation tuple. Audit and
extend that source rather than creating another handwritten catalogue.

## Baseline evidence — 2026-08-04

Verified from `/home/calluma/projects/mdbase-connect` at beta.31 commit
`eafb7eb`:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `MDBASE_CONNECT_ENV=test MDBASE_CONNECT_SECRET_BACKEND=insecure-test-file cargo test --workspace`
- `fnm exec --using=24 pnpm build`
- `fnm exec --using=24 pnpm typecheck`
- `fnm exec --using=24 pnpm test`
- `pnpm check:operations`
- `pnpm check:consumer-artifacts`
- `fnm exec --using=24 pnpm test:integration`
- `fnm exec --using=24 pnpm test:system`

The complete system matrix passed: local connector restart/grant lifecycle,
multi-instance PostgreSQL/NATS relay recovery, hosted sync, PostgreSQL hosted
provider including writer races/backups/restarts, S3-compatible hosted files,
the adversarial file lifecycle suite, packaged container restart, and the
Docker-backed Electron desktop path.

Canonical consumer checkouts passed their committed beta.28 verification
commands without worktree changes:

- Editor: typecheck, 227 unit tests, production build, bundle budget, CSP.
- Workouts: typecheck, 22 unit tests, manifest verification, production build.
- Pickle: format, typecheck, lint, 14 unit tests, production build.
- TaskNotes: format, typecheck, lint, 456-test coverage run, both layer coverage
  gates, both conformance suites, and production build.

Workouts and TaskNotes initially exposed stale beta.23 packages in
`node_modules` while their lockfiles and audited artifacts specified beta.28.
After exact frozen-lock reinstalls (`npm ci` and pnpm 10.7.0
`--frozen-lockfile`), both authoritative runs passed. No consumer worktree was
modified.

The unqualified Rust workspace test was also exercised and its only failure was
the daemon secret-store test timing out while attempting to reach the desktop
DBus keyring. The supported explicit test backend above makes the full workspace
green and is the authoritative headless result.

The optional consumer Playwright/browser-shell and Android smoke commands are
tracked for the real candidate-artifact migration slice because they exercise
installed artifacts and native packaging rather than the beta.28 compile/unit
baseline. They are not waived from the later consumer/rollout gates.

## Exit gate — green

ADR 0005 is accepted; the mutator and problem catalogues are generated into
both runtimes; the version matrix and deployment switch are frozen; the four
consumer compile spikes freeze the public shape; fingerprint bytes are shared
and adversarially tested; artifact provenance is enforced; and the full current
baseline above is green. Phase 1 may proceed independently. Phase 2 remains
gated until Phase 1 is also green.
