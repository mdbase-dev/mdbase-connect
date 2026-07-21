import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { backfillSessionProviders, createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("database migrations", () => {
  it("backfills existing GitHub sessions with their authentication provider", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();

    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
      userId,
      "existing@example.com",
      "Existing User"
    ]);
    await db.query(
      `INSERT INTO external_identities (provider, subject, user_id, login)
       VALUES ('github', '12558714', $1, 'existing')`,
      [userId]
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'existing-token', now() + interval '30 days')`,
      [randomUUID(), userId]
    );

    await backfillSessionProviders(db);

    const session = await db.query<{ provider: string }>(
      "SELECT provider FROM sessions WHERE user_id = $1",
      [userId]
    );
    expect(session.rows[0]?.provider).toBe("github");
  });
});
