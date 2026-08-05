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
updated_at: 2026-08-05T22:23:00+10:00
progress_summary: Delivery slice 9 is complete on immutable beta.33 source 55b536aafa9a1ae1031171fa7e39ae99fa4530f0. Exact SHA-512-verified packages are pinned in Editor eb48e42, Workouts fa5684c, Pickle 5e3cbe0, and TaskNotes 6febc15; every product-specific compile, unit, browser/native, manifest/build, and real-authority recovery gate is green. Application configuration provisioning and Final SDK polish are also complete in this same train. No staging or production deployment has occurred; Phase 7 is the only remaining program slice.
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

## Superseded candidate evidence

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

The gate was initially closed on 2026-08-05, then reopened when the Phase 7
audit proved that package versions were described as diagnostic while the live
relay still used them as the effective compatibility boundary. The `e1c1f49`
artifacts remain useful migration evidence but are not release candidates.

## Compatibility correction evidence

- Operation transport is now v2 while grant encryption remains its independent
  v1 key-agreement/AEAD profile. Authorization binding v3 signs the exact
  operation transport, authorization, semantic capability, and conditional
  durable-mutation requirements.
- Relay hello/welcome and hosted readiness advertise structured support sets.
  Compatibility uses version-set intersection, accepts a lower package version
  when every required contract intersects, and returns the axis-specific typed
  problem before authorization, read, replay-ledger, journal, or collection
  state. A live WebSocket regression proves control responses remain v1 while
  operation requests and responses independently round-trip on transport v2.
- A mixed-version encrypted integration fixture authenticates an unsupported
  durable mutation and proves `operation_outcome: not_sent`, zero replay-ledger
  rows, and no collection file. Authorization and hosted-readiness tests cover
  each axis independently.
- The beta.32 control-plane migration removes incompatible pending requests,
  revokes credentials for v2 local grants, and retains each grant and its audit
  history with an explicit reauthorization marker. It preserves collection
  data and never mechanically re-signs authorization intent.
- The obsolete `ENCRYPTED_RELAY_PROTOCOL_VERSION` façade is removed. Loopback
  readiness, CLI diagnostics, and pending-authorization storage name operation
  transport directly; migration 0015 copies the historical `relay_protocol`
  column and drops it. The MCP gateway no longer emits the removed beta.28
  `/oauth/authorize` query: it persists a distinct installation identity,
  signs authorization binding v3 with the exact four-axis requirements, posts
  `/oauth/authorization_request`, and follows only its opaque request URI.
- Local verification on 2026-08-05: `pnpm run build`, the complete `pnpm run
  test`, `cargo test --workspace`, `cargo check --workspace`, protocol/client/
  server focused suites, daemon tests, and `pnpm run check:architecture` pass.
  The browser SDK remains within its fixed 182,000-byte raw and 46,000-byte gzip
  budgets at 181,097 and 45,997 bytes.
- PR Editor CI first exposed one remaining v1 operation-envelope assertion in
  the remote hosted-authority Playwright harness. The harness now consumes the
  canonical operation transport constant for requests and responses; the full
  local Editor Playwright matrix passes 47/47.
- Replacement Server CI exposed three release-fixture lifecycle gaps rather
  than product downgrades. The local system harness now signs binding v3 with
  its exact compatibility requirements and passes the complete MVP E2E. The
  Windows filesystem recovery tests explicitly drop every watcher-owning
  registry before bounded fixture removal; both restart/fencing tests pass.
- Hosted-provider migration `0026_notification_connect_contracts.sql` upgrades
  persisted beta.28 notification-grant projections before strict Rust
  deserialization. It derives the durable-mutation ceiling from the exact
  stored operation and file permissions, and the previous-provider upgrade
  program asserts `2|3|1|1` for its mutation-capable fixture. Hosted-provider
  unit tests, shell syntax, workspace formatting, and the embedded migration
  build pass locally.
- Server CI run `30964080966` proves migration `0026` through the complete
  beta.28 previous-provider notification-recovery path and proves the watcher
  lifecycle correction on Windows 2025 as well as Linux and macOS. Its hosted
  provider job then exposed the remaining stale multi-instance relay fixture.
- The relay fixture now signs exact binding-v3 contract requirements,
  advertises `CONNECT_CONTRACT_SUPPORT` in its control-v1 hello, uses operation
  transport v2 for plain requests and responses, and independently retains
  grant encryption v1. The exact multi-instance NATS relay system suite passes
  locally; replacement CI is required before closing the slice.
- Replacement Server CI run `30964684133` passes the corrected relay suite,
  cross-platform durability, and previous-provider migration. Its next provider
  stage exposed two more stale hosted fixtures: the generic operation request
  wrapper still emitted control protocol v1, and the runtime notification grant
  omitted its explicit compatibility ceiling.
- Hosted operation requests now use the canonical operation transport v2 while
  file, sync, import, and grant-encryption v1 messages remain independently
  unchanged. The mutation-capable notification grant derives exact binding-v3
  requirements. The complete hosted-provider E2E passes locally through
  notification recovery, quotas, authority transfer, browser/SDK, files,
  restart, backup/restore, token rotation, revocation, and body limits.

The slice closes again only after one immutable post-correction Connect commit
produces all six packages, all four consumer PRs pin exactly those artifacts,
and their required product gates are rerun.

## Final beta.33 candidate — 2026-08-05

- Artifact source: `55b536aafa9a1ae1031171fa7e39ae99fa4530f0`.
  Connect, Devkit, Protocol, Sync, Pickle, and Testing are all beta.33 packages
  from that exact revision. `pnpm check:consumer-artifacts` verifies the
  declared byte lengths, SHA-512 digests, package files, and lockfile references
  in every consumer.
- Final consumer heads are Editor `eb48e42`, Workouts `fa5684c`, Pickle
  `5e3cbe0`, and TaskNotes `6febc15`. All worktrees are clean and pushed.
- TaskNotes, the final and strongest integration gate, found and fixed an
  application-owned Today-view date comparison during fresh-collection setup.
  Repeated live relay dogfood then proved reviewed configuration plus type-pack
  setup, namespaced view creation/execution, lost-response recovery, and one
  logical write.
- The final candidate passed `cargo check --workspace`, `cargo test
  --workspace`, the full JavaScript test/typecheck train, architecture and
  release-readiness checks, and package audit. Earlier rejected beta.32
  artifacts remain evidence only and must not be deployed.

Slice 9 is closed. Phase 7 may use only this release train (or a newly frozen
replacement if deployment discovers a correctness defect).

## Rejected packed candidate `62513b927384`

- Connect merge commit `62513b927384959600c66fb76b50d3bc90134e08`
  passed Server CI `30965358301`, Desktop release CI `30965358308`, post-merge
  Server CI `30966039505`, post-merge Editor CI `30966039504`, and signed image
  publication `30966577643`.
- All six packages were then built and packed from a clean detached worktree at
  that exact commit. Artifact-manifest verification proved all four consumers
  were temporarily pinned to one `0.1.0-beta.32-62513b927384` set.
- Workouts passed 24 tests, typecheck, build, and 10 browser tests. Pickle passed
  its full verify and 8 browser tests. TaskNotes passed its full 352-test verify;
  its browser rerun was deferred after a concurrent local server occupied its
  Playwright port.
- Editor passed 240 unit tests, typecheck, and build. Its packed-artifact browser
  run passed 42 tests but correctly failed authorization recovery because
  Playwright serialized `writeSeed` without the imported
  `GRANT_ENCRYPTION_PROTOCOL_VERSION` binding. Two remote-authority assertions
  also still expected operation transport v1.
- The release train stopped before a tag, consumer commit, staging deployment,
  or production change. `62513b927384` is rejected evidence, not a release
  candidate.
- The Connect correction copies grant encryption v1 into the browser fixture
  seed before crossing the Playwright evaluation boundary. Its regression
  serializes the function into an isolated realm and executes the connector
  path through IndexedDB and WebCrypto; package test, typecheck, and build pass
  under Node 24.13.0.
- Draft Connect PR `mdbase-dev/mdbase-connect#185` packages committed source
  `7f689ed697f2`. The packed Testing output resolves the imported constant while
  constructing the seed and reads only `seed.grantEncryptionProtocolVersion`
  inside the serialized callback.
- Editor commit `ae6aad7` replaces only operation request/response envelope
  literals with `OPERATION_TRANSPORT_PROTOCOL_VERSION`; independent file and
  encryption v1 fixtures remain unchanged. Exact `7f689ed697f2` artifacts pass
  the focused authorization/remote-authority run 3/3 and the complete browser
  matrix 45/45, including 10,000-note performance and accessibility.
