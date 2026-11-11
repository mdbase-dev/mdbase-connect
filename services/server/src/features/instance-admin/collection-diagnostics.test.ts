import { describe, expect, it, vi } from "vitest";
import { runAuthAdminCommand } from "../../auth-admin.js";
import type { DatabasePool } from "../../db.js";

describe("collection diagnostic arguments", () => {
  it.each([
    [], ["--user", "fixture", "--limit", "0"], ["--user", "fixture", "--limit", "26"],
    ["--user", "fixture", "--limit", "1.5"], ["--user", "fixture", "--collection", "invalid"],
    ["--user", "fixture", "--cursor", "invalid"], ["--user", "fixture", "--actor", "operator"],
    ["--user", "fixture", "--collection", "11111111-1111-4111-8111-111111111111", "--cursor", "11111111-1111-4111-8111-111111111111"]
  ])("rejects invalid or unbounded input before connecting: %j", async (...flags) => {
    const connect = vi.fn();
    const db = { connect } as unknown as DatabasePool;
    await expect(runAuthAdminCommand(["collections", "diagnose", ...flags], { db, defaultRegistrationMode: "closed" })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
