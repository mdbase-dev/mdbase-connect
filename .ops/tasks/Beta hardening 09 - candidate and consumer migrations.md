---
title: Beta hardening 09 - candidate and consumer migrations
status: in_progress
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 9
phase: 6
depends_on: [Beta hardening 06 - management correctness, Beta hardening 07 - public SDK surface]
tags: [beta, packaging, consumers, editor, workouts, pickle, tasknotes]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T07:03:00+10:00
progress_summary: The final beta.32 candidate from Connect commit 4680eadb3b06 is now consumed by all four canaries: Workouts 2b8a953, Editor c701dca, Pickle f1c7c6e, and TaskNotes 5c55752. TaskNotes passes its complete verification, conformance, browser, production-smoke, isolated real-authority response-loss/restart, Capacitor sync, and Android build gates. Dogfooding also found and fixed a Strict Mode lifecycle-remount defect. Physical Android-device smokes for Pickle and TaskNotes remain unavailable because no device is attached.
type: task
---

# Beta hardening 09 - candidate and consumer migrations

## Outcome

Build one candidate artifact set from one Connect commit, then migrate and
prove Editor, Workouts, Pickle, and TaskNotes in implementation order with
durable response-loss recovery and every product-specific gate.

## Current state

- The actual SDK root, rather than a parallel candidate declaration, compiles
  all four consumer spikes and their removed-API assertions.
- Workspace package audit and the in-repo Editor build/tests are green.
- The final artifact source is Connect commit
  `4680eadb3b06d70d83edfdfeb5940e00c5e06aee`. Its six beta.32 packages and
  SHA-512 hashes are recorded in the generated candidate manifest.
- Editor integration found that `operation_outcome_unknown` did not always
  include the durable request ID. Commits `51bc556` and `79c6e43` bind that
  problem to `details.request_id`, update generated protocol contracts, and
  keep all fixtures type-valid.
- mdbase Editor commit `8ef38b9` completed the API migration, and follow-up
  commit `502bc26` repins it to the final `8edc7b327c2a` beta.32 artifacts. Its
  229 unit tests, 42 Playwright tests, typecheck, build, bundle/CSP checks, and
  manifest validation pass. Rename, delete, and type-pack response-loss paths
  resume the exact stored request ID.
- Workouts integration found two authority defects instead of papering over
  them in the consumer. Commit `79176cc` makes full-collection access satisfy
  semantic contract capabilities, while `8edc7b3` translates explicit portable
  contract selectors under full access in both local and hosted dispatch.
- mdbase Workouts commit `f61217f` consumes the exact `8edc7b327c2a` Connect and
  protocol artifacts. It uses bounded/cancellable reads and writes, generation-
  aware shared scans, durable unknown-write recovery, explicit definition
  review, and an isolated HTTPS Connect dogfood path. Offline install reported
  zero vulnerabilities; typecheck, 24 unit tests, manifest verification,
  production build, 10 browser tests, and the real authorize/read/create/pause
  dogfood test are green.
- Pickle integration exposed a missing domain boundary: `@mdbase-dev/pickle`
  did not forward request budgets or own the recorded-versus-pending response
  outcome. Connect commits `161dd7a` and `4680ead` add those APIs and exact
  request-ID recovery, keeping transport problem parsing out of the app UI.
- Pickle commit `3dd5612` consumes the exact `4680eadb3b06` Connect, protocol,
  and Pickle artifacts. Startup, authorization callbacks, definition updates,
  list/respond, watch startup/lifetime, and notification binding are bounded
  and cancellable. Native backgrounding suspends foreground work, browser close
  and deep-link replay are typed/tested, and an unknown response remains visible
  and resumes by its original durable request ID after reopen. `pnpm verify`
  passes with 18 tests, desktop/mobile Playwright is 8/8, Capacitor sync is
  green, and the debug APK builds with the installed JDK 21. No Android device
  is attached, so the physical-device smoke has not run.
- Pickle follow-up commit `f1c7c6e` adds an opt-in, isolated HTTPS dogfood
  harness against a real paired authority. The test allows response creation to
  complete, drops the HTTP response, observes the durable pending state, reloads
  the application, recovers the original request ID, and proves exactly one
  response Markdown file. It passes in 8.1 seconds; the ordinary desktop/mobile
  Playwright matrix remains 8/8, and `pnpm verify` passes with 19 tests. The
  notification criterion now reads the canonical CloudEvent `data` field and
  reaches the expected local push-not-configured boundary without a criterion
  evaluation error.
- Workouts commit `2b8a953` and Editor commit `c701dca` repin their already-green
  migrations to the exact `4680eadb3b06` artifact set. Focused verification is
  green at 24 Workouts tests and 236 Editor tests.
- TaskNotes commits `0214a59`, `e6beba3`, and `bbc14b4` atomically repin the
  exact `4680eadb3b06` Connect, devkit, protocol, and testing artifacts; map
  application intent to durable authority request IDs; recover the exact
  pending request before later canonical reads or writes; and apply explicit
  request budgets and lifecycle cancellation across authorization, repository,
  files, notifications, and collection switching.
- TaskNotes commit `5c55752` adds the isolated HTTPS real-authority harness. It
  completes a create at the authority, drops the successful response, observes
  the retained draft and typed failure state, reloads, recovers the original
  request, and proves exactly one new Markdown task. The first run exposed that
  React Strict Mode cleanup aborted initial repository opening while the
  repository retained its rejected initialization promise. The same commit
  resets interrupted initialization on lifecycle resume and adds a regression
  test; the real dogfood proof then passed in 10.1 seconds.
- TaskNotes `pnpm verify` passes with 352 tests, application/domain coverage
  thresholds, 4,983 TaskNotes conformance cases (4,982 pass, one documented
  skip), the real mdbase collection oracle, manifest validation, and production
  build. Desktop/mobile Playwright is 8/8 and production smoke is 7/7.
  Capacitor sync and the Android debug build with JDK 21 are green. No Android
  device is attached, so the physical-device smoke has not run.
- TaskNotes' current product architecture has no application-owned offline task
  replica or sync queue. The mdbase collection is the sole durable collection
  boundary; bounded in-session caches and the separate application mutation
  journal do not form a second authority. Replica/sync/transfer criteria in the
  original canary wording are therefore not applicable and have been replaced
  in the parent plan with direct-authority lifecycle and recovery gates.
- The earlier beta.31, `48af56d`, `8edc7b3`, and `161dd7a` candidate directories are retained
  only as immutable rejected evidence. They are superseded and must not be
  copied into another consumer.

## Next

Run Pickle and TaskNotes physical Android-device smokes when a device becomes
available. In parallel, finish the independent cross-authority mutator matrix
and supported desktop-platform evidence required by the program before closing
this slice and admitting the rollout gate.
