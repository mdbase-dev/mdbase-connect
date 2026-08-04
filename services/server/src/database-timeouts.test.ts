import { describe, expect, it } from "vitest";
import { postgresPoolConfig } from "./db.js";
import { isDatabaseTimeoutError } from "./platform/error-handler.js";

describe("database timeout policy", () => {
  it("bounds control-plane pool, query, statement, lock, and transaction waits", () => {
    expect(postgresPoolConfig("postgres://example.test/mdbase")).toMatchObject({
      connectionTimeoutMillis: 5_000,
      query_timeout: 20_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000
    });
  });

  it.each([
    [{ code: "57014", message: "canceling statement due to statement timeout" }, true],
    [{ code: "55P03", message: "canceling statement due to lock timeout" }, true],
    [{ message: "timeout exceeded when trying to connect" }, true],
    [{ code: "23505", message: "duplicate key" }, false],
    [new Error("unrelated"), false]
  ])("classifies only bounded database waits", (error, expected) => {
    expect(isDatabaseTimeoutError(error)).toBe(expected);
  });
});
