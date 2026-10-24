import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import type { InstallationApplication } from "../applications/store.js";
import { installationApp } from "./installation-pairing.js";
import { createDatabase } from "../../db.js";
import { registerApplicationManifest } from "../../manifest.js";
import { upsertApplication } from "../applications/store.js";

const local = "http://127.0.0.1:48218", id = "11111111-1111-4111-8111-111111111111";
function registry(config: InstallationApplication["installation_origins"] = {
  lab: {"app-runtime": [local, "https://lab.notes.example.test"], mobile: ["capacitor://notes.example.test"]},
  production: {"app-runtime": ["https://notes.example.test"]},
  staging: {"app-runtime": ["https://staging.notes.example.test"]},
}) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({rows: params[0] === id ? [{id, name: "Independent Notes", family_identity: "bundle:independent.notes.app", installation_origins: config, requirements: {access:"full_collection",contracts:[]}, notifications: {criteria:[]}}] : []}));
  return {db: {query} as unknown as DatabasePool, query};
}
describe("registered installation origins", () => {
  it("authorizes a non-TaskNotes application using only its registered name and exact origins", async () => {
    const {db, query} = registry();
    for (const origin of [local, "https://lab.notes.example.test"]) {
      const app = await installationApp(db, "lab", id, origin, "app-runtime");
      expect(app).toEqual({id, origin, name: "Independent Notes"}); expect(Object.isFrozen(app)).toBe(true);
    }
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM applications"), [id]);
  });
  it.each(["local", "production", "staging", undefined, "development", "LAB", "__proto__"])("LAB origin never appears in %s environment policy", async environment => {
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
  it.each(["null", "https://*.example.test"])("refuses an opaque or wildcard Origin even in retained data: %s", async origin => {
    const { db } = registry({ lab: { "app-runtime": [origin] } });
    await expect(installationApp(db, "lab", id, origin, "app-runtime")).rejects.toMatchObject({ code: "installation_app_not_allowed", status: 403 });
  });
  it("reports corrupt retained origin data as an invariant failure, not expected unauthorized input", async () => {
    for (const config of [null, [], {lab: null}, {lab: {"app-runtime": "not-an-array"}}, {lab: {"app-runtime": [3]}}]) {
      const {db} = registry(config as never);
      await expect(installationApp(db, "lab", id, local, "app-runtime")).rejects.toThrow("Invalid registered installation");
    }
  });
});

const journal = {
  manifest_version: 1,
  id: "dev.example.journal",
  name: "Journal",
  homepage: "https://journal.example.test/",
  redirect_uris: ["https://journal.example.test/callback"],
  requirements: { access: "full_collection", contracts: [] },
};

describe("self-registered application pairing origins", () => {
  it("pairs from its declared homepage without operator configuration", async () => {
    const db = await createDatabase("memory");
    try {
      const app = await upsertApplication(db, registerApplicationManifest(journal));
      expect((await db.query("SELECT installation_origins FROM applications WHERE id=$1", [app.id])).rows[0].installation_origins).toEqual({});
      expect(await installationApp(db, "production", app.id, "https://journal.example.test", "app-runtime"))
        .toEqual({ id: app.id, origin: "https://journal.example.test", name: "Journal" });
      await expect(installationApp(db, "production", app.id, "https://journal-lookalike.example.test", "app-runtime"))
        .rejects.toMatchObject({ code: "installation_app_not_allowed", status: 403 });
    } finally { await db.end(); }
  });
  it("assigns a different registered identity when a lookalike changes the declaration origin", async () => {
    const db = await createDatabase("memory");
    try {
      const original = await upsertApplication(db, registerApplicationManifest(journal));
      const copy = await upsertApplication(db, registerApplicationManifest({ ...journal,
        homepage: "https://lookalike.example.test/", redirect_uris: ["https://lookalike.example.test/callback"] }));
      expect(copy.id).not.toBe(original.id);
      expect(copy.canonical_identity).not.toBe(original.canonical_identity);
      await expect(installationApp(db, "production", original.id, "https://lookalike.example.test", "app-runtime"))
        .rejects.toMatchObject({ code: "installation_app_not_allowed" });
      expect(await installationApp(db, "production", copy.id, "https://lookalike.example.test", "app-runtime"))
        .toMatchObject({ id: copy.id, origin: "https://lookalike.example.test" });
    } finally { await db.end(); }
  });
  it.each([1, 2])("registers exact optional loopback and capacitor origins for contract version %s", async version => {
    const db = await createDatabase("memory");
    try {
      const manifest = { ...journal, requirements: { ...journal.requirements,
        ...(version === 2 ? { capabilities: { contract_version: 2, required: ["collection.read"] } } : {}) } };
      const input = { ...manifest, installation_origins: { lab: {
        "app-runtime": [local], mobile: ["capacitor://journal.example.test"]
      } } };
      const declared = registerApplicationManifest(input), plain = registerApplicationManifest(manifest);
      expect(declared.canonicalIdentity).not.toBe(plain.canonicalIdentity);
      const app = await upsertApplication(db, declared);
      expect(await installationApp(db, "lab", app.id, local, "app-runtime")).toMatchObject({ id: app.id, origin: local });
      expect(await installationApp(db, "lab", app.id, "capacitor://journal.example.test", "mobile")).toMatchObject({ id: app.id });
      for (const [environment, origin, kind] of [
        ["production", local, "app-runtime"], ["lab", "http://127.0.0.1:48219", "app-runtime"],
        ["lab", "capacitor://journal.example.test", "app-runtime"], ["lab", "capacitor://lookalike.example.test", "mobile"]
      ] as const) await expect(installationApp(db, environment, app.id, origin, kind)).rejects.toMatchObject({ code: "installation_app_not_allowed" });
    } finally { await db.end(); }
  });
  it.each(["https://*.example.test", "https://journal.example.test/", "https://user@journal.example.test", "http://remote.example.test", "null"])
    ("refuses a wildcard, URL or unsafe optional origin %s", origin => {
      expect(() => registerApplicationManifest({ ...journal, installation_origins: { production: { "app-runtime": [origin] } } })).toThrow();
    });
  it("registers an exact Chrome extension origin as an app runtime, and nothing broader", async () => {
    const extension = `chrome-extension://${"a".repeat(16)}${"p".repeat(16)}`;
    const db = await createDatabase("memory");
    try {
      const app = await upsertApplication(db, registerApplicationManifest({ ...journal, installation_origins: { production: { "app-runtime": [extension] } } }));
      expect(await installationApp(db, "production", app.id, extension, "app-runtime")).toMatchObject({ id: app.id, origin: extension });
      for (const [origin, kind] of [[extension, "mobile"], [`chrome-extension://${"b".repeat(32)}`, "app-runtime"]] as const)
        await expect(installationApp(db, "production", app.id, origin, kind)).rejects.toMatchObject({ code: "installation_app_not_allowed" });
    } finally { await db.end(); }
    for (const [origin, kind] of [[`moz-extension://${"a".repeat(32)}`, "app-runtime"], [extension.toUpperCase(), "app-runtime"],
      [`${extension}/`, "app-runtime"], [`chrome-extension://${"a".repeat(31)}`, "app-runtime"], [extension, "mobile"]] as const)
      expect(() => registerApplicationManifest({ ...journal, installation_origins: { production: { [kind]: [origin] } } })).toThrow();
  });
  it("preserves the TaskNotes0066 record and its retained mobile and loopback origins", async () => {
    const db = await createDatabase("memory");
    try {
      const tasknotes = "5cdfa020-c201-4da8-845a-f2cc9969eade";
      for (const [origin, kind] of [[local, "app-runtime"], ["capacitor://app.tasknotes.dev", "mobile"]] as const)
        expect(await installationApp(db, "lab", tasknotes, origin, kind)).toMatchObject({ id: tasknotes, name: "TaskNotes", origin });
    } finally { await db.end(); }
  });
});
