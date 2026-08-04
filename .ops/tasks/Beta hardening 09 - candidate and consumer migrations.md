---
title: Beta hardening 09 - candidate and consumer migrations
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 9
phase: 6
depends_on: [Beta hardening 06 - management correctness, Beta hardening 07 - public SDK surface]
tags: [beta, packaging, consumers, editor, workouts, pickle, tasknotes]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T08:49:15+10:00
progress_summary: Complete. One exact six-package beta.32 candidate from Connect commit e1c1f49cca00 is pinned with SHA-512 integrity in Editor, Workouts, Pickle, and TaskNotes. Their pushed draft PRs pass focused/full product verification, browser recovery dogfood, and production builds; Pickle and TaskNotes additionally pass configured Android 36 emulator lifecycle, notification, opaque-push, and process-restart smokes.
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

## Final candidate and exit evidence

- Artifact source: Connect commit `e1c1f49cca00bbae51e7f1d9ffb5e05c576bb753`.
  The Connect, Devkit, Protocol, Sync, Pickle, and Testing tarballs all report
  `0.1.0-beta.32-e1c1f49cca00`; the generated manifest records their SHA-512
  hashes, and `pnpm check:consumer-artifacts` verifies every consumer pin.
- Editor: branch `agent/beta32-connect-hardening`, draft PR
  `mdbase-dev/mdbase-editor#73`, head `5b26518`. Typecheck, build, bundle/CSP,
  240 unit tests, and all 45 desktop/mobile/remote-authority Playwright tests
  pass, including 10k-note performance and durable response-loss recovery.
- Workouts: branch `agent/beta32-connect-hardening`, draft PR
  `callumalpass/mdbase-workouts#21`, head `7829ad2`. Typecheck, manifest, build,
  24 tests, 10 browser tests, and live beta.32 authorization/read/create/pause
  dogfood pass. Legacy seed types are mapped in place through transactional
  authorization and existing records remain visible.
- Pickle: branch `agent/beta32-connect-hardening`, draft PR
  `callumalpass/pickle-android#18`, head `63bab98`. Full verify, 8 desktop/mobile
  Playwright tests, live response-loss/reload recovery, Capacitor sync, Gradle
  test/lint/debug build, and the Android 36 emulator smoke pass. The emulator
  proof covers response flow, hardware Back, notification channel, FCM
  registration, live opaque push, and process restart.
- TaskNotes: branch `agent/beta32-connect-hardening`, draft PR
  `callumalpass/tasknotes-app#91`, head `3101679`. Full verify passes 352 tests,
  coverage, 4,983 conformance cases (4,982 pass, one documented skip), the
  mdbase oracle, manifest, and build. Eight desktop/mobile Playwright tests,
  live response-loss/reload recovery, Capacitor sync, Gradle test/lint/debug
  build, and the Android 36 notification/FCM/live-opaque-push/process-restart
  smoke pass.
- The consumer branches and PRs are intentionally draft until the coordinated
  release train completes Phase 7. No consumer mixes artifacts or sources from
  another Connect commit.

Exit gate closed green on 2026-08-05. Phase 7 may begin.
