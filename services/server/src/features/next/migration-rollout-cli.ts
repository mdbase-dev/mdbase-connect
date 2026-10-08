// Operator tool for the staged hosted migration (decision 3). Writes only the
// rollout tables; never flips an account (only the migrator does, with evidence).
//
//   next-migration-rollout status
//   next-migration-rollout pause <reason>
//   next-migration-rollout resume <reason>
//   next-migration-rollout cohort-create <name>
//   next-migration-rollout cohort-add <name> <account-id>...
//   next-migration-rollout cohort-release <name>
//
// DATABASE_URL selects the control database; MDBASE_OPERATOR names the operator,
// recorded with every change (audit_events). Every change prints the resulting state.
import { createDatabase } from "../../db.js";
import { addToCohort, createCohort, releaseCohort, rolloutState, setPaused } from "./migration-rollout.js";

async function main(argv: string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const [command, ...args] = argv;
  const actor = process.env.MDBASE_OPERATOR ?? "";
  if (command !== "status" && !actor.trim()) throw new Error("MDBASE_OPERATOR (who is making this change) is required.");
  const db = await createDatabase(url);
  try {
    switch (command) {
      case "status": break;
      case "pause": await setPaused(db, true, args.join(" "), actor); break;
      case "resume": await setPaused(db, false, args.join(" "), actor); break;
      case "cohort-create": await createCohort(db, args[0] ?? "", actor); break;
      case "cohort-add": {
        const added = await addToCohort(db, args[0] ?? "", args.slice(1), actor);
        console.log(JSON.stringify({ added: added.length, skipped: args.length - 1 - added.length }));
        break;
      }
      case "cohort-release":
        if (!(await releaseCohort(db, args[0] ?? "", actor))) throw new Error("No unreleased cohort of that name.");
        break;
      default: throw new Error("Usage: status | pause <reason> | resume <reason> | cohort-create <name> | cohort-add <name> <account-id>... | cohort-release <name>");
    }
    const cohorts = await db.query<{ name: string; released_at: Date | null; members: string }>(
      `SELECT c.name, c.released_at, count(m.account_id)::text AS members
       FROM next_migration_cohorts c LEFT JOIN next_migration_cohort_members m ON m.cohort = c.name
       GROUP BY c.name ORDER BY c.created_at`
    );
    console.log(JSON.stringify({ rollout: await rolloutState(db), cohorts: cohorts.rows }, null, 2));
  } finally { await db.end(); }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
