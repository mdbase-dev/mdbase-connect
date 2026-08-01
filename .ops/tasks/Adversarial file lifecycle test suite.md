---
title: Adversarial file lifecycle test suite
status: done
priority: critical
owner: codex
tags: [files, hosted, concurrency, fault-injection, testing, reliability]
created_at: 2026-08-01T20:44:58+10:00
updated_at: 2026-08-01T20:59:27+10:00
type: task
---

## Context

Hosted file finalization crosses PostgreSQL and R2 without a shared
transaction. Sequential success, replay, and cleanup coverage did not exercise
the stale-state interleaving where commit wins its database transaction while
a concurrent abort or expiry loses its conditional update but nevertheless
deletes the committed object.

## Desired outcome

Build a reusable adversarial lifecycle suite that deterministically controls
database and object-store interleavings, checks cross-store safety invariants,
supports multiple provider instances, and makes new race scenarios cheap to
add. Avoid timing-dependent sleeps and one-off test hooks.

## Plan

1. Introduce reusable integration-test support for a controlled blob store,
   lifecycle setup, deterministic database barriers, and invariant assertions.
2. Cover both winners of commit versus abort and commit versus expiry, duplicate
   finalization, cleanup, restart/retry, and multi-provider execution.
3. Correct every lifecycle defect exposed by the deterministic scenarios.
4. Add a dedicated CI entry point and document how to extend and run the suite.
5. Run focused adversarial tests and the complete repository verification
   matrix, recording exact evidence here.

## Notes

Implementation continues in the isolated `agent/file-support` worktree at
`/home/calluma/projects/mdbase-connect-file-support`.

## Handoff

Completed in `428287d` and `63ddb92`.

The suite uses the real hosted provider, migrations, and PostgreSQL transaction
boundaries with a deterministic implementation of the public `BlobStore`
contract. One-shot checkpoints model copies immediately before and after
destination visibility; PostgreSQL lock observation schedules database winners
without guessed sleeps. The reusable invariant auditor compares R2 objects with
current and historical references and verifies all collection file counters and
terminal transfer states.

Covered schedules:

- commit wins while a stale abort loses its conditional transition;
- commit wins after crossing expiry while stale expiry cleanup loses;
- abort and expiry win while a previously started copy publishes late;
- abort wins after the copied destination is already visible;
- duplicate commits within one provider and across independent providers.

The defects exposed by these tests were corrected by making cleanup conditional
on winning the durable terminal-state transition and by compensating a late
copy only after PostgreSQL proves the transfer is aborted or expired. Database
uncertainty intentionally retains the object rather than risking deletion of a
committed file.

Verification evidence:

- `pnpm e2e:files:adversarial`: passed, seven deterministic schedules;
- `cargo fmt --all -- --check`: passed;
- `cargo clippy --workspace --all-targets -- -D warnings`: passed;
- `cargo test --workspace`: passed;
- `pnpm check:architecture`: passed;
- `pnpm typecheck`: passed;
- `pnpm test`: passed;
- `pnpm e2e:files`: passed against disposable PostgreSQL and S3-compatible
  storage;
- `pnpm e2e`: builds passed, then the existing portal assertion timed out
  waiting for `Use a local folder` (reproduced by running `node scripts/e2e.mjs`
  directly);
- `node scripts/hosted-provider-e2e.mjs`: provider, quota, compaction, mirror,
  promotion, and import phases passed; the external editor page now renders
  `Your notes, as files.` where the stale assertion expects `Your connections.`

The two browser assertion failures occur outside the changed file lifecycle and
are unchanged external UI drift, not suppressed failures.
