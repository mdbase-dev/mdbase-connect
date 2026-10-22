# Hosted migration routing

Migrated collections are served by the environment's hosted migration Worker
(`mdbase-next-hosted-mig-<environment>`), before and after the account's backend
flip. Releases never shrink that serving. The control plane therefore routes the
hosted role of every **legacy hosted collection** (a `hosted_collections` id) of a
**released, frozen, nonterminal cohort member** to that Worker. Every other
collection, including one a migrated owner creates after the flip and any
CP-native cloud copy it already had, stays on the control plane's own hosted and
escrow deployments. The route covers hosted service-device generation, durable policy wakes, migration
admission, app (`/v1/hosted/app`) discovery and the hosted record, state,
log-token and claim readers. No account label, HTTP account field, grant owner
supplied by a caller, or new-account default selects a destination. It does not
change custody inside an existing Worker.

## Environments

Admission reads only this deployment's own `MDBASE_CONNECT_ENVIRONMENT`, never a
request or flag:

| Environment | Connect origin (`PUBLIC_URL`) | Migration Worker | Routing |
| --- | --- | --- | --- |
| `lab` | `https://connect-lab.mdbase.dev` | `mdbase-next-hosted-mig-lab.<account>.workers.dev` | admitted |
| `staging` | `https://connect-staging.mdbase.dev` | `mdbase-next-hosted-mig-staging.<account>.workers.dev` | admitted |
| `production` | `https://connect.mdbase.dev` | `mdbase-next-hosted-mig-production.<account>.workers.dev` | refused: `migration_routing_production_disabled` |
| `local`, other | | | refused: `migration_routing_environment_refused` |

Production is enabled only by changing the single code switch
`PRODUCTION_MIGRATION_ROUTING_ENABLED` in
`services/server/src/features/next/migration-routing.ts`, once the production
migration Worker's custody key, backups, recovery replica and monitoring are in
place. No setting enables it.

## Settings

Configure all three together:

- `MDBASE_NEXT_MIGRATION_HOSTED_URL`: HTTPS origin of the environment's migration Worker.
- `MDBASE_NEXT_MIGRATION_HOSTED_TOKEN`: CP outbound service credential; matches
  that Worker's `HOSTED_SERVICE_TOKEN`.
- `MDBASE_NEXT_MIGRATION_INBOUND_TOKEN`: hosted-role inbound credential; matches
  that Worker's `CP_INBOUND_TOKEN`.

LAB only:

- `MDBASE_NEXT_LAB_MIGRATION_ACCOUNT`: optional fallback comma-separated list of
  1–128 unique canonical non-nil approved account UUIDs (maximum 8192 trimmed
  bytes). Unset or blank selects DB membership only. Spaces around elements are
  allowed; empty elements within a list, duplicates and malformed UUIDs are refused.
- Compatibility: LAB still accepts the earlier names
  `MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL`, `MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN`
  and `MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN` in place of the three above (never
  mixed with them). Remove them once the LAB deployment uses the current names.

Startup refuses partial configuration, another deployment's origin or Worker,
the ordinary hosted Worker origin, shared credentials, disabled factories/migration
fronts, or concurrent isolated PITR routing. The default `MDBASE_NEXT_HOSTED_CLIENT_URL`
remains optional: authenticated discovery for each matched account uses the
validated scoped origin without supplying a default for unmatched accounts.
Existing `MDBASE_NEXT_HOSTED_*` settings remain the default. Escrow routing is unchanged. The dedicated migration
credential remains `MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN` on CP and
`CP_MIGRATION_TOKEN` on the Worker, distinct from both directions above.

## Routing

A collection is migration routed only when it is a legacy hosted collection
(`hosted_collections` row) whose owner is routed. Its owner resolves through
authoritative retained native, hosted, local and logical identity mappings;
ambiguous ownership fails closed. A not-yet-registered collection has no mapping,
so creating a collection always generates both service devices on the control
plane's own deployments, whoever creates it. Migrated collections keep their
legacy id, so this never moves a migrated collection.

One DB-backed collection route covers hosted service-device generation,
durable policy wakes, migration admission, direct Noise discovery and claim
readers, so they always agree on a collection's deployment. Its account part
joins the owner's actual cohort membership to its release/freeze state and
rejects terminal exclusion. It continues routing before/after start and backend
flip and does not use the global rollout pause as a routing switch. Hosted record, state,
log-token and CPP claim readers reject the wrong deployment credential for the
resolved owner; state batches crossing matched and unmatched deployment scopes
are refused, while batches wholly inside the matched scope use its credential. The escrow credential
retains its existing kind-scoped behavior.

This configuration is routing, not migration approval, key readiness or serving
authority. Exact current batch/claim/device and fixture-profile admission remain separate;
`[test]` names are never routing authority. Worker legacy/KMS/source-child scopes
must independently cover the real rehearsal collections; accepting several
accounts does not qualify those resources or multiple hosted collections per
account. The runner invokes the product CLI separately for each exact account. Enable it only after the separate Worker's real KMS configuration,
qualified source/WASM, signed build trust and fixture scope are ready. Removing
the configuration is not a data rollback: it does not restore DO state, credentials,
provider fences or an account backend flip, and it strands migrated collections; a deployed code version is also not
such a rollback.

## LAB cleanup: retiring a disposed fixture's route

When a LAB scope is released, the migration Worker stops serving its routed
collections. A fixture collection that is kept (not deleted) must have its route
retired, or the control plane keeps waking and routing it to a Worker that no
longer serves it:

```sh
curl -X POST -H "authorization: Bearer $MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN" \
  -H 'content-type: application/json' -d '{"actor":"<operator>","reason":"<why>"}' \
  https://connect-lab.mdbase.dev/internal/v1/next/migration/collections/<collection id>/routing/retire
```

The route is mounted only when routing is configured in LAB, and accepts only the
migration token. It requires a registered collection whose owner is currently
routed (`409 not_migration_routed` otherwise), and is idempotent: the first call
records the retirement and its `next_migration.routing_retired` audit event.

A retired collection has no hosted deployment at all: no policy wake is sent to
either deployment, app discovery returns no hosted route (never the default), and
neither hosted credential can read its records or state. Retirement is permanent
for that collection and is removed only with the collection.
