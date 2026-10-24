// Operator tool for parked mdbase-next policy queues (docs/policy-queue.md).
//
//   next-policy-queue status
//       Parked batches, and the age of the oldest policy work not yet in a log.
//   next-policy-queue unpark <collection id> <reason>
//       Resumes the collection's parked batches with their bytes unchanged.
//
// DATABASE_URL selects the control database; MDBASE_OPERATOR names the operator,
// recorded with the reason on every resumed batch (audit_events).
import { createDatabase } from "../../db.js";
import { policyQueueHealth } from "./policy-outbox.js";
import { unparkPolicyQueue } from "./policy-recovery.js";

const USAGE = "Usage: status | unpark <collection id> <reason>";

async function main(argv: string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const [command, collection, ...reason] = argv;
  if (command !== "status" && command !== "unpark") throw new Error(USAGE);
  if (command === "unpark" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(collection ?? "")) throw new Error(USAGE);
  const db = await createDatabase(url);
  try {
    if (command === "unpark") {
      const resumed = await unparkPolicyQueue(db, collection!, { actor: process.env.MDBASE_OPERATOR ?? "", reason: reason.join(" ") });
      console.log(JSON.stringify({ collection_id: collection, resumed }, null, 2));
    }
    const parked = await db.query(
      `SELECT collection_id, id AS batch_id, seq, error, attempts, lost_at IS NOT NULL AS lost, created_at
       FROM next_policy_batches WHERE state = 'parked' ORDER BY id LIMIT 100`
    );
    console.log(JSON.stringify({ ...(await policyQueueHealth(db)), parked: parked.rows }, null, 2));
  } finally { await db.end(); }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
