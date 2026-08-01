# Functional stress testing

The functional stress runner exercises synchronization and recovery through
seeded, replayable sequences. It uses disposable in-memory state or a real
Fastify HTTP server backed by the reference authority and `pg-mem`. It never
opens an installed Connect profile or a user's collections.

## Commands

```bash
pnpm stress:quick
pnpm stress:functional
pnpm stress:http
pnpm stress:scale
pnpm stress:soak
pnpm stress:soak:smoke
pnpm test:stress-regressions
```

`stress:quick` runs the same seeds through the direct in-process transport and
the HTTP boundary, then requires identical final records and semantic action
traces. `stress:functional` explores more seeds and interleavings without HTTP
overhead. `stress:http` concentrates on server serialization and restart
recovery. `stress:scale` increases replicas, records, and operation count.
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
pnpm stress:quick -- --seed SEED --transport memory
```

The runner checks these invariants:

- acknowledged mutations survive retry and restart;
- duplicate delivery has one observable effect;
- pending mutations survive cursor reset;
- concurrent stale writes produce a usable conflict;
- replicas converge after conflicts are resolved;
- snapshots contain unique IDs and paths;
- no-op pull, sync, and mirror passes do not change durable content;
- the reference authority survives reconstruction from durable state;
- revoked replicas cannot continue reading; and
- direct and HTTP transports reach identical states for the same seed.

## Scope

The runner is intentionally lightweight. The HTTP mode starts a real server but
does not start Docker, PostgreSQL, NATS, Electron, or the Rust hosted provider.
Use the existing `e2e:ecosystem`, `e2e:relay`, `e2e:provider`,
`e2e:authority:stress`, and `e2e:provider:stress` commands for those boundaries.
True OS process-kill testing and upgrade-from-previous-release fixtures remain
separate future extensions; server reconstruction in this runner verifies the
same durable reference-authority state transition without container overhead.
