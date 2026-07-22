import { createDatabase } from "./db.js";

const db = await createDatabase();
await db.end();
