import { afterEach, describe, expect, it } from "vitest";
import {
  AccountUnavailableError,
  createExternalSession
} from "./external-auth.js";
import { createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("external account sessions", () => {
  it("blocks account creation while allowing a previously linked identity", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const identity = {
      provider: "google" as const,
      subject: "linked-subject",
      name: "Invited User",
      login: null,
      email: "invited@example.com",
      emailVerified: true,
      avatarUrl: null
    };

    await expect(createExternalSession(db, identity, {
      allowAccountCreation: false
    })).rejects.toBeInstanceOf(AccountUnavailableError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(0);

    const created = await createExternalSession(db, identity);
    await expect(createExternalSession(db, identity, {
      allowAccountCreation: false
    })).resolves.toMatchObject({ userId: created.userId });
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);
  });

  it("captures the account epoch and refuses sessions for suspended accounts", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const identity = {
      provider: "google" as const,
      subject: "subject-1",
      name: "Beta User",
      login: null,
      email: "beta@example.com",
      emailVerified: true,
      avatarUrl: null
    };
    const first = await createExternalSession(db, identity);
    const firstSession = await db.query<{
      account_session_epoch: number;
      revoked_at: Date | null;
    }>(
      `SELECT account_session_epoch, revoked_at
       FROM sessions WHERE user_id = $1`,
      [first.userId]
    );
    expect(firstSession.rows[0]).toMatchObject({
      account_session_epoch: 1,
      revoked_at: null
    });

    await db.query(
      "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1",
      [first.userId]
    );
    await createExternalSession(db, identity);
    const epochs = await db.query<{ account_session_epoch: number }>(
      `SELECT account_session_epoch FROM sessions
       WHERE user_id = $1 ORDER BY created_at, id`,
      [first.userId]
    );
    expect(epochs.rows.map(({ account_session_epoch }) => account_session_epoch))
      .toEqual([1, 2]);

    await db.query(
      "UPDATE users SET suspended_at = now() WHERE id = $1",
      [first.userId]
    );
    await expect(createExternalSession(db, identity))
      .rejects.toBeInstanceOf(AccountUnavailableError);
    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sessions WHERE user_id = $1",
      [first.userId]
    );
    expect(count.rows[0]?.count).toBe("2");
  });
});
