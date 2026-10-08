## Added

- Add native-only local rollback binding preparation with a durable, idempotent result for each collection and rollback ID. Replays do not rotate twice; identity, inventory or binding drift fails closed. Preparation does not reverse account migration, reactivate a connector or authorize application access.
