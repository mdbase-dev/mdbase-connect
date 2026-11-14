import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthAdminCommand } from "../../auth-admin.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import {
  nextOpsMetricsSlot,
  OpsMetricsPushWorker,
  parseOpsMetricsPushEnv,
  validateOpsMetricsPushConfig
} from "./ops-metrics-push.js";

const TOKEN = "test-ingest-bearer-value";
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (resources.length) await resources.pop()?.();
});

describe("ops metrics push schedule", () => {
  const at = (iso: string) => Date.parse(iso);
  const slot = (iso: string) => new Date(nextOpsMetricsSlot(at(iso))).toISOString();

  it("runs at 00:40, 06:40, 12:40 and 18:40 UTC", () => {
    expect(slot("2026-11-15T00:00:00.000Z")).toBe("2026-11-15T00:40:00.000Z");
    expect(slot("2026-11-15T00:39:59.999Z")).toBe("2026-11-15T00:40:00.000Z");
    expect(slot("2026-11-15T03:12:00.000Z")).toBe("2026-11-15T06:40:00.000Z");
    expect(slot("2026-11-15T12:41:00.000Z")).toBe("2026-11-15T18:40:00.000Z");
    expect(slot("2026-11-15T23:59:59.999Z")).toBe("2026-11-16T00:40:00.000Z");
    expect(slot("2026-12-31T20:00:00.000Z")).toBe("2027-01-01T00:40:00.000Z");
  });

  it("treats a slot that has been reached as past", () => {
    expect(slot("2026-11-15T00:40:00.000Z")).toBe("2026-11-15T06:40:00.000Z");
    expect(slot("2026-11-15T18:40:00.000Z")).toBe("2026-11-16T00:40:00.000Z");
    expect(slot("2026-11-15T18:40:00.001Z")).toBe("2026-11-16T00:40:00.000Z");
  });
});

describe("ops metrics push configuration", () => {
  it("is off unless configured", () => {
    expect(parseOpsMetricsPushEnv({})).toBeNull();
    expect(parseOpsMetricsPushEnv({ OPS_METRICS_INGEST_URL: " ", OPS_METRICS_INGEST_TOKEN: "" })).toBeNull();
  });

  it("requires both values together", () => {
    expect(() => parseOpsMetricsPushEnv({ OPS_METRICS_INGEST_TOKEN: TOKEN })).toThrow(/configured together/);
    expect(() => parseOpsMetricsPushEnv({ OPS_METRICS_INGEST_URL: "https://ingest.example.test/v1/snapshots" }))
      .toThrow(/configured together/);
    expect(parseOpsMetricsPushEnv({
      OPS_METRICS_INGEST_URL: "https://ingest.example.test/v1/snapshots",
      OPS_METRICS_INGEST_TOKEN: TOKEN
    })).toEqual({ url: "https://ingest.example.test/v1/snapshots", token: TOKEN });
  });

  it("requires HTTPS, production, and never echoes the values", () => {
    const valid = { url: "https://ingest.example.test/v1/snapshots", token: TOKEN };
    expect(() => validateOpsMetricsPushConfig(valid, "production")).not.toThrow();
    for (const url of ["http://ingest.example.test/v1/snapshots", "https://user:pass@ingest.example.test/", "not a url"]) {
      let message = "";
      try {
        validateOpsMetricsPushConfig({ url, token: TOKEN }, "production");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/OPS_METRICS_INGEST_URL/);
      expect(message).not.toContain("ingest.example.test");
      expect(message).not.toContain(TOKEN);
    }
    expect(() => validateOpsMetricsPushConfig(valid, "staging")).toThrow(/production/);
  });
});

describe("ops metrics push", () => {
  it("posts the operator usage report for each window with the bearer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-15T06:40:00.000Z") });
    const db = await database();
    const ingest = await mockIngest(() => 201);
    const { worker, logs } = pushWorker(db, ingest.url);

    expect(await worker.pushSlot(Date.now())).toBe("pushed");

    expect(ingest.requests).toHaveLength(4);
    for (const [index, days] of [1, 7, 30, 90].entries()) {
      const request = ingest.requests[index]!;
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(request.body)).toEqual(await runAuthAdminCommand(
        ["usage", "report", "--days", String(days)],
        { db, defaultRegistrationMode: "closed" }
      ));
    }
    expect(logs.map((entry) => entry.details)).toEqual(
      [1, 7, 30, 90].map((days) => ({ window_days: days, status: 201 }))
    );
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("retries a failed window once and does not retry a refusal", async () => {
    const db = await database();
    const statuses = [503, 201, 401, 500, 500, 201];
    const ingest = await mockIngest(() => statuses.shift() ?? 201);
    const { worker, logs } = pushWorker(db, ingest.url);

    expect(await worker.pushSlot(Date.now())).toBe("pushed");

    // 1 day: 503 then 201; 7 days: 401 once; 30 days: 500 twice; 90 days: 201.
    expect(ingest.requests.map((request) => JSON.parse(request.body).window.days)).toEqual([1, 1, 7, 30, 30, 90]);
    expect(logs.filter((entry) => entry.level === "warn").map((entry) => entry.details)).toEqual([
      { window_days: 7, attempts: 1, status: 401 },
      { window_days: 30, attempts: 2, status: 500 }
    ]);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("logs an unreachable ingest without its address", async () => {
    const db = await database();
    const ingest = await mockIngest(() => 201);
    await ingest.close();
    const { worker, logs } = pushWorker(db, ingest.url);

    expect(await worker.pushSlot(Date.now())).toBe("pushed");
    expect(logs).toHaveLength(4);
    for (const entry of logs) {
      expect(entry.level).toBe("warn");
      expect(entry.details).toMatchObject({ attempts: 2, error_class: expect.any(String) });
    }
    expect(JSON.stringify(logs)).not.toContain(ingest.url);
  });

  it("lets one instance push a slot", async () => {
    const memory = await database();
    const db = withSharedAdvisoryLock(memory);
    const ingest = await mockIngest(() => 201);
    const slot = Date.now();
    const first = pushWorker(db, ingest.url, { lockHoldMs: 200 }).worker;
    const second = pushWorker(db, ingest.url, { lockHoldMs: 200 }).worker;

    const results = await Promise.all([first.pushSlot(slot), second.pushSlot(slot)]);
    expect(results.sort()).toEqual(["pushed", "skipped"]);
    expect(ingest.requests).toHaveLength(4);

    // An instance that reaches the lock after the hold skips the stale slot.
    expect(await second.pushSlot(slot)).toBe("skipped");
    expect(ingest.requests).toHaveLength(4);
  });
});

function pushWorker(db: DatabasePool, url: string, overrides: { lockHoldMs?: number } = {}) {
  const logs: Array<{ level: "info" | "warn"; details: Record<string, unknown>; message: string }> = [];
  const worker = new OpsMetricsPushWorker({
    db,
    config: { url, token: TOKEN },
    log: {
      info: (details, message) => logs.push({ level: "info", details, message }),
      warn: (details, message) => logs.push({ level: "warn", details, message })
    },
    lockHoldMs: overrides.lockHoldMs ?? 50,
    retryDelayMs: 1,
    requestTimeoutMs: 2_000
  });
  resources.push(() => worker.close());
  return { worker, logs };
}

async function database(): Promise<DatabasePool> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  return db;
}

// pg-mem grants every advisory lock; model one PostgreSQL session lock.
function withSharedAdvisoryLock(db: DatabasePool): DatabasePool {
  let held = false;
  return {
    query: db.query.bind(db),
    end: () => db.end(),
    async connect() {
      const connection = await db.connect();
      return {
        async query(text: string, values?: unknown[]) {
          if (text.includes("pg_try_advisory_lock")) {
            const acquired = !held;
            held = true;
            return { rows: [{ acquired }], rowCount: 1 } as never;
          }
          if (text.includes("pg_advisory_unlock")) {
            held = false;
            return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 } as never;
          }
          return connection.query(text, values);
        },
        release: () => connection.release()
      };
    }
  };
}

async function mockIngest(status: () => number) {
  const requests: Array<{ method: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(status(), { "content-type": "application/json" });
      response.end(JSON.stringify({ echoed: "response bodies are never read" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/snapshots`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  resources.push(close);
  return { requests, url, close };
}
