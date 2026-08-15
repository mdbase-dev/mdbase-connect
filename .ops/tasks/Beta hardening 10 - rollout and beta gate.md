---
title: Beta hardening 10 - rollout and beta gate
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 10
phase: 7
depends_on: [Beta hardening 09 - candidate and consumer migrations]
tags: [beta, deployment, canary, observability, rollback]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-06T03:28:00+10:00
progress_summary: Complete. Staging and production run exact signed beta.34 images after restore-tested checkpoints and verified automatic whole-train rollback. Workouts, Editor, Pickle, and TaskNotes passed in order with clean observations; broker recovery, a 60-minute zero-failure soak, production acceptance, retained rollback evidence, and two clean post-promotion snapshots are green. The external-beta invitation gate is satisfied; no invitations were sent by this task.
type: task
---

# Beta hardening 10 - rollout and beta gate

## Outcome

Stage the coordinated breaking release train, prove contract-aware activation
and whole-train rollback, canary Workouts, Editor, Pickle, then TaskNotes with
privacy-safe observation, and satisfy every external-beta invitation gate.

## Gate state

Initially opened 2026-08-05, then returned to `open` when the compatibility
audit reopened delivery slice 9. Production and staging remain untouched.
Staging must activate the complete release train behind explicit contract-aware
readiness, prove whole-train rollback, and retain the documented canary order
before any external-beta invitation.

## Ready-to-activate evidence — 2026-08-05

- Source and every consumer worktree are clean and pushed; exact artifact
  verification is green across all four applications.
- Connect's complete Rust/JavaScript, architecture, release-readiness, package,
  performance, and system gates are green at the frozen source commit.
- Consumer gates are green through TaskNotes' fresh relay-backed setup and
  durable response-loss/reload proof, including both Android emulator smokes.
- The beta.33 server/connector pair has been exercised locally with an isolated
  database, broker, account, connector, and collection. This is test evidence,
  not a staging or production activation.

The next action is the single production-shaped deployment workflow requested
by the user. Preserve the old stack and verified database checkpoint as the
rollback target before activating any schema that it cannot reopen.

## Staging rollout evidence — 2026-08-06

- Staging activation uses beta.34 source
  `ea56354739626c55f05a485cd707164740b2c391` and exact signed image digests.
  beta.34 is a runtime-only correction that exposes the already-shipped
  privacy-safe metrics; all consumers retain the exact beta.33 SDK artifacts.
- Two earlier activations detected the missing snapshot evidence and restored
  the complete beta.31 train automatically. The corrected activation passed
  signed image identity, migrated readiness, OAuth v4, candidate manifests,
  and browser CORS.
- Workouts, Editor, Pickle, and TaskNotes were merged and deployed one at a
  time. Each hold produced a clean journal/pool/boundary observation before the
  next canary advanced; final deployed-manifest verification passes for all
  four applications.
- The broker drill observed the required HTTP 503 while Core NATS was
  suspended, recovered stable readiness after resume, and reran the full signed
  acceptance suite successfully.
- Workflow `31024686507` is performing the mandatory 60-minute continuous
  soak. Production promotion is committed in cloud-ops main
  `2cd2987fadf09e81ab30a9354c0648f91aa4625d`, but deployment is held until the
  soak and production checkpoint workflow `31024842803` both succeed.

## Production rollout and gate closure — 2026-08-06

- Soak workflow `31024686507` passed its complete 3,600-second window with 110
  samples, 660 endpoint checks, zero transient failures, and full signed
  acceptance at both boundaries.
- Production checkpoint workflow `31024842803` encrypted and restore-tested all
  three databases and retained artifact
  `encrypted-production-backups-31024842803` for the destructive prerelease
  migration rollback boundary.
- Promotion workflow `31029549943` deployed the exact staged beta.34 image set
  from cloud-ops main `2cd2987fadf09e81ab30a9354c0648f91aa4625d`.
  The three exact production reset waivers passed, prior live digests were
  recorded, all four services reached live in dependency order, and rollback
  artifact `production-deployment-state-31029549943` is retained.
- Workflow and independent production acceptance passed exact image identity,
  health/readiness, OAuth device and semantic web writes, all four public
  declarations, R2 browser CORS, and entitlement reconciliation.
- Two consecutive privacy-safe production journal snapshots show completed
  state only, no unfinished age or failure events, and available pool capacity.

All rollout, rollback, observation, documentation, and external-beta invitation
criteria are satisfied. Invitations were deliberately left to the normal
human-owned product process rather than being sent by this engineering task.
