## Fixed

- Bring the runtime up to the code serving migrated hosted collections: projected queries admit each record once, writes no longer stall after a device is keyed by a later-epoch grant, native sync no longer stalls at the first periodic snapshot, repair budgets count confirmed own intents, and file reads wait for the attachment region. The SDK serializes uploads, exposes record IDs, isolates storage per vault and separates native loopback storage from LAB permissions.
