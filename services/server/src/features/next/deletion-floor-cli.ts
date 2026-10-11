// Operator rerun for the native deletion floor of an owner-deleted collection.
//
//   next-deletion-floor rerun <collection id>
//       Re-sends the collection's committed CP deletion tuple to the native
//       registry. Exact retries are idempotent; a different tuple already on
//       record is refused and reported, never overwritten. Reads DATABASE_URL and
//       the next control-plane environment the server uses.
import { createDatabase } from "../../db.js";
import { LogServiceClient } from "./log-service-client.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";

const [command, collection] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command !== "rerun" || !collection || !/^[0-9a-f-]{36}$/u.test(collection)) throw new Error("usage: next-deletion-floor rerun <collection id>");
  const config = parseNextControlPlaneEnv(process.env);
  if (!config) throw new Error("The next control-plane environment is required.");
  const db = await createDatabase();
  try {
    const row = (await db.query<{ deletion_id: string; epoch: string }>(
      `SELECT deletion_id,lifecycle_epoch::text AS epoch FROM next_collection_deletion_facts
       WHERE collection_id=$1 AND authority='cp-intent'`, [collection]
    )).rows[0];
    if (!row) throw new Error("No owner deletion is recorded for this collection.");
    const fact = { collection, deletionId: row.deletion_id, lifecycleEpoch: BigInt(row.epoch) };
    const recorded = await new LogServiceClient(config.logService).recordCollectionDeletion(fact);
    console.log(JSON.stringify({ collection, deletion_id: fact.deletionId, lifecycle_epoch: row.epoch, registry_generation: recorded.generation.toString() }));
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.constructor.name}: ${error.message}` : error);
  process.exitCode = 1;
});
