---
title: Adversarial file lifecycle test suite
status: in_progress
priority: critical
owner: codex
tags: [files, hosted, concurrency, fault-injection, testing, reliability]
created_at: 2026-08-01T20:44:58+10:00
updated_at: 2026-08-01T20:44:58+10:00
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

Work is active. Begin by designing the test-support boundary around the public
`BlobStore` abstraction and disposable PostgreSQL rather than expanding the
existing monolithic Node E2E script.
