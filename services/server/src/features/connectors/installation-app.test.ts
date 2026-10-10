import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import type { InstallationApplication } from "../applications/store.js";
import { installationApp } from "./installation-pairing.js";

const local = "http://127.0.0.1:48218", id = "11111111-1111-4111-8111-111111111111";
function registry(config: InstallationApplication["installation_origins"] = {
  lab: {"app-runtime": [local, "https://lab.notes.example.test"], mobile: ["capacitor://notes.example.test"]},
  production: {"app-runtime": ["https://notes.example.test"]},
  staging: {"app-runtime": ["https://staging.notes.example.test"]},
}) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({rows: params[0] === id ? [{id, name: "Independent Notes", family_identity: "bundle:independent.notes.app", installation_origins: config}] : []}));
  return {db: {query} as unknown as DatabasePool, query};
}
describe("registry-owned installation origins", () => {
  it("authorizes a non-TaskNotes application using only its registered name and exact origins", async () => {
    const {db, query} = registry();
    for (const origin of [local, "https://lab.notes.example.test"]) {
      const app = await installationApp(db, "lab", id, origin, "app-runtime");
      expect(app).toEqual({id, origin, name: "Independent Notes"}); expect(Object.isFrozen(app)).toBe(true);
    }
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM applications"), [id]);
  });
  it.each(["production", "staging", undefined, "development", "LAB", "__proto__"])("LAB origin never appears in %s environment policy", async environment => {
    await expect(installationApp(registry().db, environment, id, local, "app-runtime")).rejects.toMatchObject({code: "installation_app_not_allowed", status: 403});
  });
  it.each(["http://localhost:48218", "http://127.0.0.1:48219", "http://127.0.0.1", "https://127.0.0.1:48218", "http://127.0.0.1:48218/", "http://127.0.0.1:48218/path", "http://127.0.0.2:48218", "null", undefined])("refuses missing/changed host, port, scheme or URL form %s", async origin => {
    await expect(installationApp(registry().db, "lab", id, origin, "app-runtime")).rejects.toMatchObject({code: "installation_app_not_allowed"});
  });
  it("uses separate exact registered production/staging policies, without fallback", async () => {
    const {db} = registry();
    expect((await installationApp(db, "production", id, "https://notes.example.test", "app-runtime")).origin).toBe("https://notes.example.test");
    expect((await installationApp(db, "staging", id, "https://staging.notes.example.test", "app-runtime")).origin).toBe("https://staging.notes.example.test");
    await expect(installationApp(db, "production", id, "https://lab.notes.example.test", "app-runtime")).rejects.toThrow();
    await expect(installationApp(db, "staging", id, "https://notes.example.test", "app-runtime")).rejects.toThrow();
  });
  it("requires explicit mobile authorization, not a missing-Origin or same-family bypass", async () => {
    const {db} = registry();
    expect(await installationApp(db, "lab", id, "capacitor://notes.example.test", "mobile")).toMatchObject({id});
    await expect(installationApp(db, "lab", id, local, "mobile")).rejects.toThrow();
    await expect(installationApp(db, "production", id, "capacitor://notes.example.test", "mobile")).rejects.toThrow();
    await expect(installationApp(db, "lab", "unknown", local, "app-runtime")).rejects.toThrow();
    await expect(installationApp(registry({}).db, "lab", id, local, "app-runtime")).rejects.toThrow();
  });
  it("reports corrupt operator configuration as an invariant failure, not expected unauthorized input", async () => {
    for (const config of [null, [], {lab: null}, {lab: {"app-runtime": "not-an-array"}}, {lab: {"app-runtime": [3]}}]) {
      const {db} = registry(config as never);
      await expect(installationApp(db, "lab", id, local, "app-runtime")).rejects.toThrow("Invalid registered installation");
    }
  });
});
