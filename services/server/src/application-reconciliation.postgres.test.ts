import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseConnection, type DatabasePool } from "./db.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const describePostgres = testUrl ? describe : describe.skip;
let db: DatabasePool | undefined;

const claimSql = `WITH candidate AS (
  SELECT application_id FROM application_reconciliation_jobs
  WHERE available_at<=now() AND NOT (application_id=ANY($2::uuid[]))
    AND (state='pending' OR (state='leased' AND lease_expires_at<=now())
      OR (state='completed' AND next_scan_at<=now()))
  ORDER BY available_at,application_id FOR UPDATE SKIP LOCKED LIMIT 1
)
UPDATE application_reconciliation_jobs AS job SET state='leased',lease_token=$1,
  lease_expires_at=now()+(($3::text || ' milliseconds')::interval),
  phase=CASE WHEN job.state='completed' THEN 'scan' ELSE job.phase END,
  cursor_grant_id=CASE WHEN job.state='completed' THEN NULL ELSE job.cursor_grant_id END,
  attempts=job.attempts+1,updated_at=now()
FROM candidate WHERE job.application_id=candidate.application_id
RETURNING job.application_id,job.cursor_grant_id,job.phase`;

async function claim(connection: DatabaseConnection) {
  return (await connection.query<{ application_id: string }>(claimSql,
    [randomUUID(), [], 60_000])).rows[0]?.application_id;
}

describePostgres("application reconciliation PostgreSQL locking", () => {
  afterAll(async () => { await db?.end(); });

  it("skips locked work, honors future availability, and returns no second one-app claim", async () => {
    db = await createDatabase(testUrl!);
    const apps = [randomUUID(), randomUUID()];
    for (const [index, app] of apps.entries()) {
      await db.query(`INSERT INTO applications
        (id,canonical_identity,family_identity,name,homepage,redirect_uris,requirements,notifications,manifest_digest)
        VALUES ($1,$2,$3,'Postgres claim test','https://example.test','[]','{"contracts":[]}',
          '{"criteria":[]}',$4)`, [app, `https://example.test/${app}`, `bundle:${app}`, "a".repeat(63) + index]);
      await db.query(`INSERT INTO application_reconciliation_jobs (application_id,available_at)
        VALUES ($1,now()-($2::text || ' seconds')::interval)`, [app, 2 - index]);
    }
    const a = await db.connect(); const b = await db.connect();
    try {
      await a.query("BEGIN");
      expect(await claim(a)).toBe(apps[0]);
      await b.query("BEGIN");
      expect(await claim(b)).toBe(apps[1]);
      await b.query("COMMIT");
      await a.query(`UPDATE application_reconciliation_jobs SET state='pending',lease_token=NULL,
        lease_expires_at=NULL,available_at=now()+interval '1 hour' WHERE application_id=$1`, [apps[0]]);
      await a.query("COMMIT");
      await b.query("BEGIN");
      expect(await claim(b)).toBeUndefined();
      await b.query("COMMIT");

      await db.query("DELETE FROM application_reconciliation_jobs WHERE application_id=$1", [apps[1]]);
      await db.query(`UPDATE application_reconciliation_jobs SET state='pending',lease_token=NULL,
        lease_expires_at=NULL,available_at=now()-interval '1 second' WHERE application_id=$1`, [apps[0]]);
      await a.query("BEGIN");
      expect(await claim(a)).toBe(apps[0]);
      await b.query("BEGIN");
      expect(await claim(b)).toBeUndefined();
      await b.query("ROLLBACK"); await a.query("ROLLBACK");
    } finally {
      await a.query("ROLLBACK").catch(() => undefined); await b.query("ROLLBACK").catch(() => undefined);
      a.release(); b.release();
      await db.query("DELETE FROM applications WHERE id=ANY($1::uuid[])", [apps]);
    }
  });
});
