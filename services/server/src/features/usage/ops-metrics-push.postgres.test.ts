import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { OpsMetricsPushWorker } from "./ops-metrics-push.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;

describePg("ops metrics push on PostgreSQL", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("dedicated local test Postgres only");
    schema = `ops_metrics_push_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("pushes a slot from one of two instances", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/snapshots`;
      const worker = () => new OpsMetricsPushWorker({
        db,
        config: { url, token: "test-ingest-bearer-value" },
        log: { info: () => undefined, warn: () => undefined },
        lockHoldMs: 500,
        retryDelayMs: 1
      });
      const instances = [worker(), worker()];
      const slot = Date.now();
      const results = await Promise.all(instances.map((instance) => instance.pushSlot(slot)));
      expect(results.sort()).toEqual(["pushed", "skipped"]);
      expect(requests).toBe(4);
      await Promise.all(instances.map((instance) => instance.close()));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
