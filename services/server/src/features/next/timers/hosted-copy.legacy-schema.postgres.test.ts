import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readHostedLegacyTimers } from "./hosted-copy.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const migrations = new URL("../../../../../../crates/connect-hosted-provider/migrations/", import.meta.url);
const legacy = JSON.parse(readFileSync(new URL("../fixtures/legacy-provider-ce339-migrations.json", import.meta.url), "utf8")) as {
  source_revision: string; files: Record<string, string>;
};
const runtime = JSON.parse(readFileSync(new URL("../fixtures/legacy-runtime-postgres-bootstrap.json", import.meta.url), "utf8")) as {
  source_revision: string; schema_version: number; statements: string[];
};

suite("CLI timer source against actual legacy ce339 provider/runtime migrations", () => {
  let admin: pg.Pool, writer: pg.Pool, reader: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Dedicated local test PostgreSQL required");
    }
    admin = new pg.Pool({ connectionString: url.href, max: 2 });
    schema = `legacy_cli_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    writer = new pg.Pool({ connectionString: url.href, max: 2 });
    // These are the real, unchanged ce339 migration files, not a schema invented
    // from the reader's expected columns. The manifest freezes their exact bytes.
    for (const [name, hash] of Object.entries(legacy.files)) {
      const sql = readFileSync(new URL(name, migrations));
      expect(createHash("sha256").update(sql).digest("hex")).toBe(hash);
      await writer.query(sql.toString());
    }
    // Verbatim SQL strings from schema.rs at the legacy Docker's mdbase-rs pin.
    for (const sql of runtime.statements) await writer.query(sql, sql.includes("$1") ? [runtime.schema_version] : undefined);
    url.searchParams.set("options", `-csearch_path=${schema} -cdefault_transaction_read_only=on`);
    reader = new pg.Pool({ connectionString: url.href, max: 2 });
  }, 60_000);
  afterAll(async () => {
    await reader?.end(); await writer?.end();
    if (schema) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("resolves every source column and scopes pending journals through real replicas, including revoked ones", async () => {
    expect(legacy.source_revision).toBe("ce339deaeff7edfbeeca1bbe149a1532ace99222");
    expect(runtime.source_revision).toBe("056db7334a0f49f10373225ae54c1abaedc14e37");
    const target = randomUUID(), foreign = randomUUID(), ownReplica = randomUUID(), foreignReplica = randomUUID();
    for (const id of [target, foreign]) {
      await writer.query(`INSERT INTO hosted_provider_collections
        (id,template,spec_version,timezone,max_records,max_content_bytes,max_document_bytes,max_mirror_replicas,max_application_replicas,
         resource_revision,wrapped_data_key,resources_ciphertext,state,legacy_migration_id,legacy_migration_started_at)
        VALUES($1,'mdbase','1','UTC',100,1000000,100000,10,10,'synthetic', $2,$2,'migrating',$3,now())`,
      [id, Buffer.alloc(32, 1), randomUUID()]);
    }
    for (const [id, collection] of [[ownReplica, target], [foreignReplica, foreign]]) {
      await writer.query(`INSERT INTO hosted_provider_replicas(id,collection_id,name,mode,token_hash,revoked_at)
        VALUES($1,$2,'Synthetic source','read_only',$3,now())`, [id, collection, Buffer.from(id!)]);
    }
    // The old CLI's fabricated column is absent in the actual migration schema.
    await expect(reader.query("SELECT collection_id FROM hosted_provider_mutation_journal")).rejects.toMatchObject({ code: "42703" });
    expect((await readHostedLegacyTimers(reader, target)).timers).toEqual([]);
    const insertJournal = (replica: string, state: string) => writer.query(`INSERT INTO hosted_provider_mutation_journal
      (replica_id,request_id,operation_kind,input_schema_version,input_digest,state,process_epoch,
       lease_owner,lease_expires_at,fencing_generation,evidence_ciphertext,evidence_kind)
      VALUES($1,$2,'synthetic',1,$3,$4,$2,$2,now()+interval '1 minute',1,$3,'sync_effect')`,
    [replica, randomUUID(), Buffer.alloc(32, 2), state]);
    await insertJournal(foreignReplica, "claimed");
    expect((await readHostedLegacyTimers(reader, target)).timers).toEqual([]);
    for (const state of ["claimed", "prepared", "applied"]) {
      await insertJournal(ownReplica, state);
      await expect(readHostedLegacyTimers(reader, target)).rejects.toThrow("source fence/schema/drain unavailable");
      // A read must neither settle nor mutate the original journal.
      expect((await writer.query("SELECT state FROM hosted_provider_mutation_journal WHERE replica_id=$1", [ownReplica])).rows).toEqual([{ state }]);
      await writer.query("DELETE FROM hosted_provider_mutation_journal WHERE replica_id=$1", [ownReplica]);
    }
    expect((await readHostedLegacyTimers(reader, target)).timers).toEqual([]);
  });
});
