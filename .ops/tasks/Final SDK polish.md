---
title: Final SDK polish
status: done
priority: high
owner: codex
parent: SDK and authority beta hardening
tags:
  - sdk
  - beta
  - developer-experience
  - public-api
  - typescript
  - request-budgets
  - lifecycle
  - consumers
created_at: 2026-08-05T12:12:48+10:00
updated_at: 2026-08-05T22:23:00+10:00
type: task
---

# Final SDK polish

## Outcome

Finish the pre-release SDK design with one deliberate breaking-change pass so
the stable surface is small, idiomatic, correctly typed, lifecycle-safe, and
pleasant for application developers. Preserve the strong authorization,
authority-routing, typed-outcome, and durable-mutation architecture; remove
accidental public machinery and wire-format leakage rather than adding another
abstraction layer.

The user expanded the beta-hardening goal on 2026-08-05 to place this task
before the final staging activation. It follows application-declared collection
configuration provisioning, and both land in one successor release train so the
production-shaped deployment, rollback, canaries, and soak run only once.

## Why this remains

Consumer upgrades validated the main architecture but exposed a final set of
issues worth resolving before the API becomes expensive to break:

- composite operations do not all uphold the documented single request-budget
  contract;
- application-session startup is not explicitly coalesced or idempotent under
  concurrent starts, cancellation, destruction, and framework remounts;
- the root package exports internal outcome/error construction machinery and a
  raw operation escape hatch that are not part of the golden path;
- application-facing TypeScript mixes camelCase options with snake_case wire
  fields; and
- query inputs retain `unknown` fields and an open index signature, allowing
  malformed or misspelled queries to compile.

## Scope

### 1. Lifecycle and request-budget correctness

1. Inventory every public asynchronous method and every composite operation.
   Enforce the documented `ConnectRequestOptions` shape wherever a bounded
   request can occur.
2. Make `MdbaseApplicationSession.start()` concurrency-safe and idempotent.
   Define and test repeated start, concurrent start, cancellation, failure,
   `destroy()`, and restart behavior. A failed or cancelled start must not leave
   a rejected promise, orphaned base session, listener, or stale state owner.
3. Add request options to `ensureCapabilities()` and carry them through the
   lower-level authorization path.
4. Fix `renameWithProgress()` and `deleteWithProgress()` so `timeoutMs` is not
   dropped. Preflight and apply must consume one monotonic remaining budget,
   while cancellation retains the correct not-sent versus unknown mutation
   semantics.
5. Make `applyDefinitionUpdates()` consume one total budget across all assessed
   packs and final verification rather than restarting the caller's timeout for
   each sub-operation.
6. Specify pagination semantics explicitly. `queryAll()` must use one total
   budget. If `queryPages()` intentionally uses a per-page budget for a
   caller-driven async iterator, name and document that distinction rather than
   overloading an apparently total `timeoutMs`.
7. Add black-hole, cancellation, concurrent-start, Strict Mode-style remount,
   and listener-cleanup tests for these paths.

### 2. Freeze a smaller public surface

1. Replace broad root `export *` statements with an explicit reviewed export
   list and a checked API inventory.
2. Keep the root package focused on the golden path: `MdbaseConnect`, the
   application session, selected connection operations, selection adapters,
   typed public outcomes/problems, notification payload helpers, files, and
   application-facing types.
3. Remove internal construction and adaptation machinery from the root,
   including raw transport/error conversion helpers, outcome-capture helpers,
   implementation error classes, and runtime problem-code arrays unless a
   demonstrated application use case requires them.
4. Remove the untyped `MdbaseConnection.operation()` escape hatch from the
   ordinary connection. Provide any genuinely required protocol-author testing
   seam through `/advanced` instead.
5. Review low-level registry methods on `MdbaseConnect` and
   `MdbaseConnection`. Keep only application-facing lifecycle operations at the
   root; move protocol and construction seams to `/advanced`.
6. Put supported problem/outcome builders and fault fixtures in
   `@mdbase-dev/connect-testing` so application tests do not need production
   access to SDK internals.
7. Add positive and negative compile fixtures against the packed package, not
   merely source aliases, for every root, `/advanced`, `/crypto`, and testing
   boundary.

### 3. Make the TypeScript API idiomatic and precise

1. Adopt one naming policy for application-facing TypeScript. Prefer camelCase
   for SDK options, inputs, results, and progress events, translating to and
   from canonical snake_case protocol payloads at the boundary. Do not rename
   user-owned frontmatter keys.
2. Cover operational fields such as `if_revision`, `include_document`,
   `frontmatter_mode`, `order_by`, `criterion_id`, `fire_at`,
   `installed_by`, `expected_assessment_digest`, and `allow_downgrade`.
3. Replace `QueryInput.where?: unknown`, `order_by?: unknown`, and the open
   string index signature with canonical query/filter/order types. Generate or
   share these definitions from the mdbase operation contract rather than
   inventing a second semantic model in Connect.
4. Ensure compile-time typos fail while valid forward-compatible record and
   frontmatter data remain representable.
5. Review the connection-level frontmatter generic. Provide a simple per-call
   result generic or another small solution if the current single generic makes
   heterogeneous collections unnecessarily untyped; do not introduce a large
   schema-code-generation system solely for this task.

### 4. Clarify package ownership and developer workflow

1. Audit direct `@mdbase-dev/connect-protocol` imports in Editor, Workouts,
   Pickle, and TaskNotes. Re-export application-facing descriptors and constants
   deliberately from `@mdbase-dev/connect`; leave authority/wire implementation
   details in the protocol package.
2. Keep sync, Pickle, development tooling, and testing independently adoptable.
   Do not merge packages merely to reduce the package count.
3. Make the normal dependency story explicit: ordinary applications install
   `@mdbase-dev/connect`; add `connect-dev`, `connect-testing`, `connect-sync`,
   or Pickle only when their feature set requires them.
4. Correct package-name drift and documentation defects, compile every public
   example, and ensure the quickstart demonstrates the final golden path with
   cancellation, typed failure handling, and uncertain-mutation recovery.

### 5. Consumer migration and performance proof

1. Pack every affected SDK artifact from one immutable Connect commit and pin
   all four consumers to that exact artifact set.
2. Migrate Editor first for breadth, then Workouts, Pickle Android, and
   TaskNotes. Remove compatibility aliases after all controlled consumers have
   moved.
3. Run each consumer's compile, unit, browser/native, and real-authority suites,
   including lifecycle cancellation and unknown-mutation recovery.
4. Retain explicit browser bundle governance: checked baseline, a 2 KiB gzip
   per-change review signal, a 52 KiB standing warning threshold, a 64 KiB gzip
   hard ceiling, and a 256 KiB raw hard ceiling. Accepted baseline increases
   must be visible in review.
5. Re-run large collection, pagination, file streaming, burst, watch, and
   platform matrices. The polish pass must not trade correctness or ergonomics
   for avoidable startup, memory, or throughput regressions.

## Non-goals

- Do not redesign authorization, semantic capabilities, authority routing,
  encrypted relay, durable mutation identity, or typed outcome taxonomy without
  a concrete correctness defect.
- Do not add React, Vue, or other framework state owners. Make the core session
  lifecycle safe and keep framework adapters thin unless consumer evidence
  demonstrates that a maintained subpath materially reduces errors.
- Do not preserve beta compatibility aliases after controlled consumers move.
- Do not broaden the protocol or add speculative convenience layers.

## Exit gate

This task is complete when:

1. every public async/composite path has tested deadline and cancellation
   semantics, with no restarted total budgets, dropped options, leaked
   listeners, or duplicate session owners;
2. a checked API report proves the reviewed root and subpath export inventory,
   and negative fixtures reject removed internals and the raw operation escape
   hatch;
3. application-facing naming is consistent, query inputs are precisely typed,
   and all boundary mapping has round-trip and wire-conformance tests;
4. ordinary consumer code no longer imports protocol internals for SDK-level
   concepts, while authority integration tests retain an explicit supported
   path;
5. Editor, Workouts, Pickle Android, and TaskNotes pass on one immutable packed
   artifact set with no compatibility façade; and
6. package audit, public API tests, documentation examples, browser CSP/bundle
   checks, performance suites, and the relevant hosted/local system suites are
   green.

## Handoff

Start with a read-only public API and request-budget audit. Turn each proposed
removal or rename into a compile-negative fixture before implementation, then
migrate all four consumers in the same release train. Keep correctness fixes
separate from mechanical naming and export movement so review can distinguish
behavioral changes from surface cleanup.

## Progress — 2026-08-05

- The request-budget, concurrent application-session lifecycle, reviewed root
  and subpath exports, camelCase SDK boundary, precise query types, testing
  package ownership, compiled documentation, CSP, and browser bundle work is
  implemented on `agent/beta33-hardening` through Connect commit `2dd725b`.
- The complete local/relay/sync/provider/files/container/desktop system train,
  stress regression suites, architecture budgets, strict Rust linting, and the
  10k mirror profiles were green before the final hosted large-collection
  optimization.
- The exact 10,003-record hosted gate now passes without relaxing a budget:
  mutation p95 84.01 ms, snapshot 1.334 s, change-page p95 27.38 ms,
  warm-read p95 46.72 ms, and warm-query p95 27.5 ms. The fix replaced
  collection-wide record-index scans with paired indexes and moved hosted
  writes onto mdbase-rs's explicit caller-owned staged-mutation boundary.
  Ordinary filesystem mutations retain their atomic shadow transaction.
- mdbase-rs PR #41 merged as `b09f5d6`; its Linux, macOS, Windows, PostgreSQL,
  packaging, dependency-policy, docs/features, full conformance, and strict
  clippy gates are green.
- The task remains open for the immutable artifact freeze, exact one-time pin
  in Editor, Workouts, Pickle Android, and TaskNotes, consumer-specific proof,
  and the single successor rollout/canary/soak cycle.

## Completion — 2026-08-05

- Final source commit `55b536aafa9a1ae1031171fa7e39ae99fa4530f0`
  passes the complete JavaScript and Rust workspaces, release-readiness and
  architecture checks, public/negative packed API fixtures, package audit,
  compiled documentation, CSP and governed browser bundle checks, and the
  local/relay/hosted/files/sync/stress/platform suites recorded above.
- One monotonic budget now spans composite operations; application-session
  startup/destroy/restart is coalesced and lifecycle-safe; pagination semantics
  are explicit; and black-hole, cancellation, Strict Mode remount, progress,
  and listener-cleanup fixtures are green.
- The root export inventory is explicit. Removed builders, adapters, raw
  operation escape hatches, and wire construction seams fail packed negative
  fixtures; supported testing builders live in `@mdbase-dev/connect-testing`,
  while `/advanced` and `/crypto` retain deliberate low-level seams.
- Application inputs/results are camelCase at the SDK boundary, query/filter/
  order types reject misspellings, heterogeneous record generics remain
  representable, and round-trip wire fixtures preserve the canonical protocol.
- The immutable beta.33 packages are pinned in Editor `eb48e42`, Workouts
  `fa5684c`, Pickle `5e3cbe0`, and TaskNotes `6febc15`. Exact byte-length and
  SHA-512 verification passes across all four consumers. Ordinary application
  code no longer imports protocol internals for SDK concepts; TaskNotes retains
  one explicit low-level authority fixture.
- Editor passes typecheck, 240 tests, build, bundle/CSP and its 45-case browser
  matrix; Workouts passes typecheck, 24 tests, manifest/build, 10 browser cases,
  and real authority dogfood; Pickle passes full verify, 8/8 browser, Android
  smoke, and response-loss recovery; TaskNotes passes full 356-test verify,
  8/8 browser, production and Android smokes, conformance, setup, and exact
  response-loss recovery.

All exit gates are satisfied. Rollout remains in the parent Phase 7 task so the
deployment, rollback proof, ordered canaries, and soak still occur exactly once.
