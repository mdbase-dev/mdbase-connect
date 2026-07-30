---
title: Codebase architecture and quality transformation
status: done
priority: critical
owner: codex
tags: [architecture, maintainability, security, testing, ci, documentation]
created_at: 2026-07-30T11:31:26+10:00
updated_at: 2026-07-30T14:56:47+10:00
type: task
---

## Context

MDBASE Connect grew from its first recorded MVP into a broad local, relay, and
hosted platform in less than two weeks. Its behavioral coverage and product
boundaries are strong, but several central implementation files now contain
multiple domains and thousands of lines. Pre-release is the best opportunity
to establish durable internal boundaries before public APIs and operating
assumptions become expensive to change.

## Desired outcome

Turn the repository into a feature-oriented modular system with:

- thin composition roots and public package facades;
- explicit application, policy, persistence, and transport boundaries;
- one authoritative owner for every security and lifecycle invariant;
- stable, versioned Rust and TypeScript protocol contracts;
- focused unit, integration, compatibility, fault-injection, accessibility,
  and end-to-end coverage;
- enforceable formatting, dependency, architecture, migration, release, and
  rollback quality gates;
- concise architecture, threat-model, ownership, and operational documentation.

## Plan

1. Capture the current architecture, dependency graph, quality baseline, and
   critical invariants.
2. Add quality guardrails that prevent further concentration while allowing
   deliberate behavior-preserving extraction.
3. Decompose the control-plane server by feature.
4. Decompose the client SDK behind a stable public facade.
5. Decompose the local registry by invariant-owning domains.
6. Decompose the hosted provider while preserving transaction ownership.
7. Model daemon targeting, capability revocation, cryptographic trust, and
   authority lifecycle states explicitly.
8. Expand narrow tests and fault injection around every extracted boundary.
9. Harden CI, dependency policy, documentation, ownership, and release checks.
10. Run the complete local and Docker-backed test matrix and audit the result.

## Working rules

- Preserve collection semantics in `mdbase-rs`.
- Keep the local connector as the final local authorization boundary.
- Do not send local paths or record payloads to the control plane.
- Keep each commit cohesive, reviewed through its diff, and green at the
  narrowest relevant test level.
- Run the full request-path and live integration suites at phase boundaries.
- Do not mix the original checkout's uncommitted desktop work into this branch.

## Notes

Work is isolated on `agent/exquisite-codebase` in the
`mdbase-connect-quality` worktree, based on `v0.1.0-beta.20`.

### Baseline and first guardrails

- The build-first baseline passes 142 Rust tests and 447 JavaScript/TypeScript
  tests.
- A clean install initially could not run `pnpm typecheck` or `pnpm test`
  without a separate build because workspace declarations resolve from
  generated `dist` directories. Root lifecycle scripts now build package
  prerequisites explicitly.
- Strict Clippy exposed one nine-argument hosted-provider mutation function.
  It now takes a typed operation context without suppressing the lint.
- The architecture check covers 138 production source files, 173 relative
  imports, and 11 workspace packages. Its own four tests bring the
  JavaScript/TypeScript total to 451.
- The first graph run found a real `db.ts` and `migrations.ts` dependency
  cycle. Database interfaces, connection composition, and the immutable legacy
  baseline are now separate modules and the cycle is removed.
- Existing production files above 1,000 lines are explicit debt entries.
  Newly extracted modules must stay below the default budget.

### Control-plane decomposition

- System health/readiness, password authentication, external authentication,
  account sessions, connector pairing, hosted mirror pairing, connector
  management, and inventory synchronization now have feature-owned route
  modules.
- Shared HTTP errors, error translation, request-origin enforcement, session
  cookies, authenticated principals, audit recording, authority URL
  construction, contract schemas, and key validation now have explicit
  platform or protocol owners.
- `services/server/src/app.ts` has fallen from 8,738 to 351 lines without
  changing the public route surface. It is now a composition root below the
  repository-wide 1,000-line production-file limit and no longer needs a
  legacy exception.
- The server suite now passes 188 tests across 41 files; the architecture
  check covers 180 production files, 441 relative imports, and 11 workspace
  packages with no source or workspace dependency cycles.
- Feature modules now own connector control, authority adoption and transfer,
  notifications, local operations, hosted account and connector management,
  reference sync, relay transport, account overview, application manifests,
  grant policy and reconciliation, and the complete authorization state
  machine.
- Authorization now has explicit route, approval, redirect, token-issuance,
  and live-offer boundaries. The `"null"` portable application origin remains
  an explicit protocol invariant covered by the existing end-to-end server
  suite.

### Client SDK decomposition

- `packages/client/src/index.ts` has fallen from 4,168 to a 66-line public
  facade and no longer needs a legacy size exception.
- Public collection operations, connection/session types, browser and memory
  selection, notifications, error classification, OAuth/device authorization,
  persisted grant state, runtime validation, and encoding now have focused
  modules.
- Refresh rotation, encrypted relay, remote authority signing, direct-loopback
  fallback, mutation recovery, and stored-token validation are owned by one
  854-line transport component behind a structural connection context.
- Every client production file is below 1,000 lines. The package passes 74
  tests, typechecking, declaration/browser builds, and repository cycle and
  size checks; the complete workspace build, typecheck, and test phase gate
  also passes.

### Local core decomposition

- `crates/connect-core/src/registry.rs` has fallen from 5,324 to a 220-line
  facade. Database migration, collection registration, authority transfer,
  operation execution, contract scoping, descriptions and changes, grants,
  encrypted replay protection, filesystem identity, and agent state now have
  focused owners.
- The 2,063-line registry scenario suite is grouped into authority,
  collections, operations, scope, and security-state modules; every production
  and test module is below 1,000 lines.
- `crates/connect-core/src/local_sync.rs` has fallen from 1,209 to 830 lines,
  with its SQLite projection helpers isolated in a 314-line persistence
  module. Both core legacy size exceptions are removed.
- The core crate passes all 41 tests, formatting, and strict Clippy after the
  extraction. The repository architecture gate now covers 210 production
  files with no source or workspace dependency cycles.

### Hosted provider decomposition

- `crates/connect-hosted-provider/src/provider.rs` has fallen from 6,550 to a
  292-line facade and no longer needs a legacy size exception.
- Complete transaction-owning flows now live in collection, authority import,
  authority transfer, replica, compaction, sync-read, mutation, and
  operation-specific modules. Encrypted persistence, capability policy,
  snapshot canonicalization, cryptographic metadata, and provider lifecycle
  helpers have focused owners.
- The largest hosted module is the 688-line authority import state machine;
  all production and test modules are below 1,000 lines.
- All 24 hosted-provider tests pass. The full Rust workspace phase gate passes
  142 tests, formatting, and strict Clippy, and the architecture check now
  covers 229 production files without dependency cycles.

### Lifecycle and protocol hardening

- The Rust/TypeScript wire contract is split into focused compatibility,
  control, encryption, grants, hosted, notifications, and sync modules behind
  a 39-line protocol facade. Existing public exports remain compatible.
- Hosted authority imports, transfers, and collection states use closed Rust
  enums that reject unknown database values and retain stable wire values.
- CLI daemon commands now distinguish the default installed service from an
  explicitly isolated state-directory or endpoint profile. Isolated commands
  cannot accidentally install, stop, restart, inspect, or remove the default
  service.
- The CLI entry point has fallen from 1,815 to 732 lines. Command mapping,
  daemon control, login, output, and tests have focused modules; every CLI
  production module is below 1,000 lines and its size exception is removed.
- Hosted grant and mirror-replica revocation now commits local denial and a
  durable provider cleanup job in one transaction before network cleanup.
  Provider failure delays cleanup without leaving the local capability active.
- The server passes 189 tests, CLI behavior passes 18 focused and integration
  tests, strict Clippy passes, and the architecture check covers 239 production
  files without dependency cycles.

### Complete production decomposition

- Server bootstrap and legacy migration helpers, the desktop main process and
  tray image construction, the desktop renderer, and the account portal are
  now split by feature. The portal's former 2,251-line root is a 44-line
  composition root; the desktop renderer is 913 lines and its main process is
  985 lines.
- The architecture gate now covers 281 production files, 585 relative imports,
  and 11 workspace packages. There are no relative-source or workspace-package
  cycles, every production module is below 1,000 lines, and the legacy budget
  map is empty.
- Connector identity private material now lives in the operating-system secret
  store with verified legacy migration and fail-closed corruption handling.
  SDK refresh enforces connector, application-key, and grant continuity while
  still allowing intentional scope and key-ID rotation.

### Test, governance, and release completion

- Provider-outage fault injection proves durable revocation recovery. A real
  persistent Chromium profile proves non-extractable browser keys and atomic
  cross-tab counters across restart. Browser accessibility gates exercise
  portal and desktop landmarks, names, headings, keyboard access, and reduced
  motion.
- CODEOWNERS, automated dependency updates, a private-reporting security
  policy, a threat model, and a maintainability handbook make ownership and
  review expectations explicit. The dependency audit has no known
  vulnerabilities.
- Five beta risks that require independent review, managed infrastructure, or
  publisher accounts are explicit in `config/release-readiness.json`. Beta CI
  reports them; stable desktop publication fails closed until each contains
  durable evidence.
- The Node 24 mirror performance baseline is tied to the exact
  pre-transformation commit and capture environment. The candidate passes its
  wall-time, heap, I/O, checkpoint, portable-adapter, and mobile bundle gates.

### Final validation

- Node 24.13.0: frozen install, version/readiness/dependency/architecture
  checks, build, typecheck, package audit, 465 JavaScript/TypeScript tests,
  persistent-browser storage, and browser accessibility all pass.
- Rust 1.94.0: formatting, strict workspace Clippy, and all 148 workspace tests
  pass.
- Live paths pass for local direct and relayed operation, multi-instance NATS,
  hosted sync, the PostgreSQL hosted provider (including restart, revocation,
  logical backup restore, browser, CLI, mirror, and authority transfer), the
  packaged Docker control plane, and the real Electron client against that
  Docker environment.
- The original dirty checkout was not modified. The complete work is on
  `agent/exquisite-codebase` as a sequence of cohesive, verified commits.
