import { openDatabase } from "./db.js";
import { runControlPlaneMigrations } from "./migrations.js";

const db = await openDatabase();
try {
  await runControlPlaneMigrations(db, {
    lock: Boolean(
      process.env.DATABASE_URL
      && process.env.DATABASE_URL !== "memory"
    )
  });
} finally {
  await db.end();
}
