# Migration SHADOW target composition

The migration-token-only `POST
/internal/v1/next/migration/collections/:id/target` composes the canonical
`createServiceCloudCopy` helper with the source collection UUID, current started
legacy owner and hardcoded `shadow` runtime. No caller-selected owner, runtime,
keys, source facts or readiness boolean is accepted.

Its authorization callback checks the actual source owner and exact microsecond
start claim around the shared creator's asynchronous boundaries. Deleted,
quarantined, transferred, terminal-excluded, backend-flipped or CP-cut-over
sources refuse. Existing suspension is preserved; this internal composition does
not enable ordinary user access. The first committed service identities/root
runtime tuple remain immutable on retry.

The result is public bootstrap metadata with exact appended-genesis readback;
it is not native H1 readiness, custody, FULL admission or a fresh authenticated
migration claim. H1 must independently qualify actual native target/history,
physical DO mapping, authenticated current CPP claim and actual saved pending /
settled-effects context before native `Created.verified` completion. That front
remains withheld until qualified. Postdrain source witnesses gate later import
stages, not this target metadata operation.

No source restore, unfreeze, cutover, route flip or operation authorization is
added here. Source-only PostgreSQL/log fixtures are not a managed migration.
