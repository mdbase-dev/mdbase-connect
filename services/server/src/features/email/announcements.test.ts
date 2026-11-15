import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { createDatabase } from "../../db.js";
import {
  createAnnouncement,
  previewAnnouncement,
  scheduleAnnouncement,
  testSendAnnouncement
} from "./announcements.js";
import { renderScheduledEmail } from "./beta-welcome-email.js";
import type { TransactionalEmail } from "./email.js";
import { ScheduledEmailWorker } from "./scheduled-email.js";

const MUTATION = { operationId: "op-1", actor: "operator:test", reason: "Announce" };
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("stored announcements", () => {
  it("refuses copy it cannot send and versions every change", async () => {
    const db = await database();
    const input = { slug: "plus", subject: "News", body: "Hi {name},\n\nNews.", betaBody: null };
    await expect(createAnnouncement(db, { ...input, slug: "Plus!" }, MUTATION))
      .rejects.toThrow(/lowercase/);
    await expect(createAnnouncement(db, { ...input, subject: "Two\nlines" }, MUTATION))
      .rejects.toThrow(/one line/);
    await expect(createAnnouncement(db, { ...input, body: "Hi {first_name}," }, MUTATION))
      .rejects.toThrow(/unknown placeholder \{first_name\}/);

    const first = await createAnnouncement(db, input, MUTATION);
    expect(first).toMatchObject({ created: true, announcement: { version: 1 } });
    expect(await createAnnouncement(db, input, MUTATION))
      .toMatchObject({ created: false, announcement: { version: 1 } });
    expect(await createAnnouncement(db, { ...input, subject: "Newer" }, MUTATION))
      .toMatchObject({ created: true, announcement: { version: 2 } });
    await expect(previewAnnouncement(db, "missing", null)).rejects.toThrow(/No announcement named missing/);
  });

  it("sends each account the version it was queued with, once", async () => {
    const db = await database();
    await account(db, "Standard Person");
    const beta = await account(db, "Beta Person", { beta: true });
    await account(db, "Unverified Person", { verified: false });
    await createAnnouncement(db, {
      slug: "plus",
      subject: "mdbase Plus",
      body: "Hi {name},\n\nPlus is here: https://connect.example/account.\n\nBest,\nCallum.",
      betaBody: "Hi {name},\n\nPlus is here, and your beta allowance stays.\n\nBest,\nCallum."
    }, MUTATION);
    const { sent, worker } = sender(db);

    // A test send is per version and doesn't count as the account's announcement.
    expect(await testSendAnnouncement(db, "plus", beta, MUTATION))
      .toMatchObject({ version: 1, queued: true });
    expect(await testSendAnnouncement(db, "plus", beta, MUTATION))
      .toMatchObject({ version: 1, queued: false });
    await worker.drainOnce();
    expect(sent()).toEqual([expect.objectContaining({
      to: "beta-person@example.com",
      subject: "mdbase Plus",
      text: expect.stringContaining("Hi Beta Person,\n\nPlus is here, and your beta allowance stays.\n\nBest,\nCallum.\n\nYou're receiving this")
    })]);
    expect(await previewAnnouncement(db, "plus", null))
      .toEqual({ version: 1, recipients: 2, already_scheduled: 0 });

    expect(await scheduleAnnouncement(db, "plus", null, MUTATION))
      .toMatchObject({ version: 1, recipients: 2, already_scheduled: 0 });
    // A later version leaves queued jobs on the version they were queued with.
    await createAnnouncement(db, {
      slug: "plus", subject: "Changed", body: "Changed.", betaBody: null
    }, MUTATION);
    await worker.drainOnce();
    const announced = sent().slice(1);
    expect(announced.map((message) => [message.to, message.subject])).toEqual(expect.arrayContaining([
      ["standard-person@example.com", "mdbase Plus"],
      ["beta-person@example.com", "mdbase Plus"]
    ]));
    const standardMessage = announced.find((message) => message.to === "standard-person@example.com")!;
    expect(standardMessage.text).toContain("Hi Standard Person,\n\nPlus is here: https://connect.example/account.");
    expect(standardMessage.html).toContain(
      '<a href="https://connect.example/account" style="color:#1f5fbf">https://connect.example/account</a>.'
    );

    expect(await scheduleAnnouncement(db, "plus", null, MUTATION))
      .toMatchObject({ version: 2, recipients: 0, already_scheduled: 2 });
    expect((await db.query(
      "SELECT event_type, count(*)::int AS count FROM audit_events GROUP BY event_type ORDER BY event_type"
    )).rows).toEqual([
      { event_type: "email.announcement_created", count: 2 },
      { event_type: "email.announcement_scheduled", count: 2 },
      { event_type: "email.announcement_test_scheduled", count: 2 }
    ]);
  });
});

async function database(): Promise<DatabasePool> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  return db;
}

async function account(
  db: DatabasePool,
  name: string,
  options: { beta?: boolean; verified?: boolean } = {}
): Promise<string> {
  const id = randomUUID();
  const address = `${name.toLowerCase().replaceAll(" ", "-")}@example.com`;
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, NULL, $2)", [id, name]);
  await db.query(
    `INSERT INTO email_identities
       (id, user_id, email, normalized_email, normalization_version, verified_at, is_primary)
     VALUES ($1, $2, $3, $3, 1, $4, true)`,
    [randomUUID(), id, address, options.verified === false ? null : new Date()]
  );
  await db.query("INSERT INTO account_email_preferences (user_id) VALUES ($1)", [id]);
  if (options.beta) {
    await db.query(
      `INSERT INTO account_entitlement_grants (id, user_id, profile_code, source, source_reference)
       VALUES ($1, $2, 'beta_v1', 'operator', 'test')`,
      [randomUUID(), id]
    );
  }
  return id;
}

function sender(db: DatabasePool) {
  const send = vi.fn(async (message: TransactionalEmail) => ({
    provider: "test",
    messageId: `message-${message.to}`
  }));
  const worker = new ScheduledEmailWorker(
    db,
    { send },
    (context) => renderScheduledEmail(db, context),
    "https://connect.example"
  );
  return { worker, sent: () => send.mock.calls.map(([message]) => message) };
}
