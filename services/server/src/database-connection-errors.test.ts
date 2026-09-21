import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "./db.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn()
  });
  const driver = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined)
  });
  vi.mocked(pg.Pool).mockImplementation(function () {
    return driver as unknown as pg.Pool;
  });
  return { driver, client, db: await openDatabase("postgres://unused.test/test") };
}

describe("PostgreSQL connection error containment", () => {
  it.each([
    ["25P03", "idle_transaction_timeout"],
    ["57P01", "connection_failure"],
    ["ECONNRESET", "connection_failure"],
    ["untrusted-server-value", "connection_failure"]
  ])("contains checked-out and idle errors with bounded diagnostics (%s)", async (code, classification) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { driver, client } = await fixture();
    const error = Object.assign(new Error("private SQL, credential and record data"), {
      code, client, detail: "private database detail"
    });

    driver.emit("acquire", client);
    expect(() => client.emit("error", error)).not.toThrow();
    driver.emit("release", error, client);
    expect(client.listenerCount("error")).toBe(0);
    expect(() => driver.emit("error", error, client)).not.toThrow();
    expect(warning.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      "privacy-safe Connect metric",
      { metric: "database_connection_failure", failure_class: classification }
    ]));
  });

  it("does not accumulate listeners on reuse or remove other owners' listeners", async () => {
    const { driver, client } = await fixture();
    const other = vi.fn();
    client.on("error", other);
    for (let i = 0; i < 30; i++) {
      driver.emit("acquire", client);
      expect(client.listenerCount("error")).toBe(2);
      driver.emit("release", undefined, client);
      expect(client.listeners("error")).toEqual([other]);
    }
    expect(driver.listenerCount("error")).toBe(1);
  });

  it("discards a client after any failed query, even after successful rollback", async () => {
    const { db, client } = await fixture();
    const connection = await db.connect();
    const error = Object.assign(new Error("fatal response before socket close"), { code: "57P01" });
    client.query.mockRejectedValueOnce(error);
    await expect(connection.query("SELECT 1")).rejects.toBe(error);
    await connection.query("ROLLBACK");
    connection.release();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls).toEqual([["SELECT 1", undefined], ["ROLLBACK", undefined]]);
  });

  it("reuses healthy clients and preserves query results, checkout errors and shutdown", async () => {
    const { db, driver, client } = await fixture();
    const connection = await db.connect();
    const result = { rows: [{ value: 1 }] };
    client.query.mockResolvedValueOnce(result);
    expect(await connection.query("SELECT $1 AS value", [1])).toBe(result);
    connection.release();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    const error = new Error("checkout failed");
    driver.connect.mockRejectedValueOnce(error);
    await expect(db.connect()).rejects.toBe(error);
    driver.query.mockResolvedValueOnce(result);
    expect(await db.query("SELECT 1 AS value")).toBe(result);
    await db.end();
    expect(driver.end).toHaveBeenCalledOnce();
  });
});
