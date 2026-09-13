import { openDatabase } from "./db.js";
import { runControlPlaneMigrations } from "./migrations.js";

const db = await openDatabase();
try {
  const evidence = await runControlPlaneMigrations(db, {
    lock: Boolean(
      process.env.DATABASE_URL
      && process.env.DATABASE_URL !== "memory"
    )
  });
  console.info(JSON.stringify({ migration_evidence: evidence }));
} finally {
  await db.end();
}
