# Functional stress testing

The functional stress runner exercises the `packages/sync` client's
synchronization and recovery through seeded, replayable sequences against the
package's in-memory authority. It uses disposable state only and never opens an
installed Connect profile or a user's collections.

## Commands

```bash
pnpm stress:quick
pnpm stress:functional
pnpm stress:scale
pnpm stress:soak
pnpm stress:soak:smoke
pnpm test:stress-regressions
```

`stress:quick` runs a few short seeds. `stress:functional` explores more seeds
and interleavings. `stress:scale` increases replicas, records, and operation
count.
`stress:soak` retains one growing system for eight hours; the smoke form proves
the soak profile and duration handling in seconds.

Every scenario deliberately covers a response lost after commit, replay of the
same mutation receipt, compaction while a mutation is pending, authority
restart, concurrent writes from one revision, revocation, replica convergence,
and repeated mirror synchronization. Random actions add create, update, rename,
delete, pull, sync, duplicate delivery, restart, compaction, and concurrent
conflict interleavings.

On failure the runner writes the seed, recent action trace, metrics, and stack
to `.tmp/stress-failures/`. Replay one seed with:

```bash
pnpm stress:quick -- --seed SEED
```

The runner checks these invariants:

- acknowledged mutations survive retry and restart;
- duplicate delivery has one observable effect;
- pending mutations survive cursor reset;
- concurrent stale writes produce a usable conflict;
- replicas converge after conflicts are resolved;
- snapshots contain unique IDs and paths;
- no-op pull, sync, and mirror passes do not change durable content;
- the authority survives reconstruction from its serialized state; and
- revoked replicas cannot continue reading.

## Scope

The runner is intentionally lightweight: it starts no server, Docker,
PostgreSQL, NATS, Electron, or Rust hosted provider. `e2e:provider` and
`e2e:provider:stress` drive the same client over HTTP against the hosted
provider; `e2e:container` and `e2e:relay` cover the packaged server and the
relay.
