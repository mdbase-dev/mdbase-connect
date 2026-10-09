import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "./db.js";
import { runControlPlaneMigrations } from "./migrations.js";

vi.mock("./migrations.js", () => ({ runControlPlaneMigrations: vi.fn() }));
const approval = "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
// Synthetic fixture credentials, never used for a connection: migration is mocked.
const base = "postgresql://fixture:fixture@127.0.0.1:5432/migration_test?application_name=fixture";
const scoped = `${base}&options=-csearch_path%3Dmigration_lock_fixture`;

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function selected(actual = scoped, approved = base) {
  vi.stubEnv("VITEST", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL", approval);
  vi.stubEnv("MDBASE_CONNECT_TEST_DATABASE_URL", approved);
  const pool = await createDatabase(actual);
  await pool.end();
  return vi.mocked(runControlPlaneMigrations).mock.calls.at(-1)?.[1];
}

describe("isolated migration lock selection", () => {
  it("selects only the approved private-schema Vitest DSN", async () => {
    expect(await selected()).toEqual({ lock: true, isolatedTestSchema: true });
  });

  it.each([
    ["VITEST", ""], ["VITEST", "false"], ["NODE_ENV", "production"],
    ["MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL", ""],
    ["MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL", "yes"],
    ["MDBASE_CONNECT_TEST_DATABASE_URL", ""]
  ])("retains the global lock without %s=%s", async (key, value) => {
    await selected();
    vi.stubEnv(key, value);
    const pool = await createDatabase(scoped);
    await pool.end();
    expect(vi.mocked(runControlPlaneMigrations).mock.calls.at(-1)?.[1])
      .toEqual({ lock: true, isolatedTestSchema: false });
  });

  it.each([
    base,
    scoped.replace("migration_lock_fixture", "public"),
    scoped.replace("migration_lock_fixture", "information_schema"),
    scoped.replace("migration_lock_fixture", "pg_catalog"),
    scoped.replace("migration_lock_fixture", "missing,public"),
    `${scoped}%20-cstatement_timeout%3D0`,
    `${scoped}&options=-csearch_path%3Dother`,
    scoped.replace("fixture:fixture", "fixture:different"),
    scoped.replace("5432", "5433"),
    scoped.replace("application_name=fixture", "application_name=other"),
    scoped.replace("migration_test", "another_test")
  ])("keeps mismatched or non-isolated DSNs on the global lock (case %#)", async (actual) => {
    expect(await selected(actual)).toEqual({ lock: true, isolatedTestSchema: false });
  });

  it.each([
    base.replace("127.0.0.1", "db.example.com"),
    base.replace("migration_test", "live"),
    `${base}&options=-cstatement_timeout%3D0`
  ])("rejects an unsafe approved base DSN (case %#)", async (approved) => {
    expect(await selected(`${approved}&options=-csearch_path%3Dmigration_lock_fixture`, approved))
      .toEqual({ lock: true, isolatedTestSchema: false });
  });

  it("keeps the memory adapter unlocked", async () => {
    expect(await selected("memory")).toEqual({ lock: false, isolatedTestSchema: false });
  });
});
