## Added

- Control-plane routing of migrated owners to the hosted migration Worker now works in staging as well as LAB, configured by `MDBASE_NEXT_MIGRATION_HOSTED_URL`, `MDBASE_NEXT_MIGRATION_HOSTED_TOKEN` and `MDBASE_NEXT_MIGRATION_INBOUND_TOKEN` and admitted only from the deployment's own environment and canonical origin. Production stays refused (`migration_routing_production_disabled`) behind a single code switch; local deployments are refused. LAB keeps accepting its earlier `MDBASE_NEXT_LAB_MIGRATION_*` names.
- LAB cleanup: `POST /internal/v1/next/migration/collections/:id/routing/retire` (migration token, LAB only) retires a disposed fixture collection's migration route, so the control plane stops waking, routing and serving records for it.
