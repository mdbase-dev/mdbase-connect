# Adversarial file lifecycle testing

The hosted file lifecycle crosses PostgreSQL and R2, so ordinary request tests
cannot establish that metadata and objects remain consistent under concurrent
finalization, cancellation, expiry, and retry. The adversarial suite forces
those interleavings deterministically and audits both stores after each one.

Run it with:

```sh
pnpm e2e:files:adversarial
```

The command starts a disposable PostgreSQL container. R2 is represented by a
controlled in-memory implementation of the public `BlobStore` contract; this
keeps scheduling exact while the production provider and real SQL migrations
remain under test.

## Test architecture

The suite lives in
`crates/connect-hosted-provider/tests/file_lifecycle_adversarial.rs`. Reusable
components are kept under its `support/` directory:

- `ControlledBlobStore` models objects and offers one-shot checkpoints before
  and after a copy becomes visible. A before-publish checkpoint can reproduce a
  copy that completes after cancellation cleanup, and injected deletion
  failures verify that cleanup intent survives an object-store outage.
- `FileLifecycleFixture` creates an isolated collection and writer and exposes
  only lifecycle-level setup operations.
- scheduling helpers observe PostgreSQL lock state instead of relying on
  guessed delays;
- the invariant auditor compares every durable object reference with stored
  objects, verifies collection counters, and rejects inconsistent terminal
  transfer states.

Scenarios run serially because table locks are intentionally global, but each
uses a fresh collection and object namespace. Provider calls themselves run on
the normal multi-threaded runtime and separate database connections.

The matrix also schedules periodic maintenance against active finalization,
late object publication, and abandoned open transfers. These cases prove both
possible winners: maintenance reclaims an unowned upload, while a commit holding
the transfer row remains authoritative and is skipped without cleanup.

## Adding a scenario

Prefer a small function named for the expected winner, such as
`commit_wins_abort_loses`. Arrange the interleaving with a copy checkpoint or a
database lock, wait for the observable checkpoint, release it, await every
participant, then call `assert_storage_consistent`. A scenario should assert
the public outcome as well as the cross-store invariant.

Do not use fixed sleeps to decide when a race has reached the intended point.
Polling an externally visible database condition is acceptable; helpers bound
all waits and produce a failure if the checkpoint is never reached.
