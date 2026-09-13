import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../canonical-json.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerApplicationManifest } from "../../manifest.js";
import { runControlPlaneMigrations } from "../../migrations.js";
import { upsertApplication, type RegisteredApplication } from "./store.js";

const databases: DatabasePool[] = [];

afterEach(async () => {
  while (databases.length) await databases.pop()?.end();
});

async function database() {
  const db = await createDatabase("memory");
  databases.push(db);
  return db;
}

function declaration(distribution: "web" | "portable") {
  return {
    manifest_version: 1,
    distribution,
    id: "dev.example.assets",
    name: "Asset Browser",
    icon: "https://assets.example/icon.svg",
    ...(distribution === "web" ? {
      homepage: "https://assets.example/",
      redirect_uris: ["https://assets.example/callback"]
    } : { project_url: "https://assets.example/source" }),
    requirements: {
      access: "full_collection",
      contracts: [],
      capabilities: { contract_version: 2, required: ["collection.read"] },
      files: {
        required: ["list", "read"],
        scope: { kind: "selected_folders", folders: ["Assets", "Exports/Final"] }
      }
    }
  };
}

async function stored(db: DatabasePool, id: string) {
  return (await db.query<RegisteredApplication>(
    "SELECT id, manifest_digest, application_declaration FROM applications WHERE id = $1", [id]
  )).rows[0];
}

describe("application declaration persistence", () => {
  it.each(["web", "portable"] as const)(
    "preserves the complete normalized %s declaration and its canonical digest",
    async (distribution) => {
      const db = await database();
      const input = declaration(distribution);
      const discovered = registerApplicationManifest(input);
      // The parser supplies defaults absent from the input; persist its output,
      // not the raw input or a reconstruction from the legacy split columns.
      expect(discovered.manifest).not.toEqual(input);
      const application = await upsertApplication(db, discovered);
      for (const row of [application, await stored(db, application.id)]) {
        expect(row.application_declaration).toEqual(discovered.manifest);
        expect(canonicalSha256(row.application_declaration))
          .toBe(`sha256:${discovered.digest}`);
        expect(row.manifest_digest).toBe(discovered.digest);
        expect(row.application_declaration).toHaveProperty("id", input.id);
        expect(row.application_declaration).toHaveProperty("manifest_version", 1);
      }
    }
  );

  it("refreshes the declaration on conflict without changing identity or merging stale keys", async () => {
    const db = await database();
    const discovered = registerApplicationManifest(declaration("portable"));
    const first = await upsertApplication(db, discovered);
    await db.query(
      `UPDATE applications SET application_declaration = $2::jsonb WHERE id = $1`,
      [first.id, JSON.stringify({ ...discovered.manifest, name: "Stale", obsolete: true })]
    );

    const updated = await upsertApplication(db, discovered);
    expect(updated.id).toBe(first.id);
    expect(updated.application_declaration).toEqual(discovered.manifest);
    expect((await stored(db, first.id)).application_declaration).toEqual(discovered.manifest);
    expect((await db.query("SELECT id FROM applications")).rows).toHaveLength(1);

    // Changed declarations have a new digest-bound identity, not an in-place
    // rewrite of a declaration already referenced by existing registrations.
    const changed = registerApplicationManifest({ ...declaration("portable"), name: "New name" });
    const next = await upsertApplication(db, changed);
    expect(next.id).not.toBe(first.id);
    expect(next.family_identity).toBe(first.family_identity);
    expect(next.application_declaration).toEqual(changed.manifest);
    expect(canonicalSha256(next.application_declaration)).toBe(`sha256:${changed.digest}`);
    expect((await stored(db, first.id)).application_declaration).toEqual(discovered.manifest);
  });

  it("leaves historical rows null across migration and reads until legitimate registration", async () => {
    const db = await database();
    // Recreate the immediately preceding schema, then exercise the migration
    // runner against a real legacy row containing only split declaration data.
    await db.query("ALTER TABLE applications DROP COLUMN application_declaration");
    await db.query("DELETE FROM schema_migrations WHERE id = '0028_application_declaration'");
    const discovered = registerApplicationManifest(declaration("portable"));
    const id = randomUUID();
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, family_identity, manifest_digest, distribution,
          name, homepage, redirect_uris, requirements, provisions, notifications)
       VALUES ($1, $2, $3, $4, 'portable', $5, '', '[]'::jsonb,
               $6::jsonb, $7::jsonb, $8::jsonb)`,
      [id, discovered.canonicalIdentity, discovered.familyIdentity, discovered.digest,
        discovered.manifest.name, JSON.stringify(discovered.manifest.requirements),
        JSON.stringify(discovered.manifest.provisions), JSON.stringify(discovered.manifest.notifications)]
    );

    await runControlPlaneMigrations(db);
    expect((await stored(db, id)).application_declaration).toBeNull();
    await runControlPlaneMigrations(db);
    expect((await stored(db, id)).application_declaration).toBeNull();

    const registered = await upsertApplication(db, discovered);
    expect(registered.id).toBe(id);
    expect(registered.application_declaration).toEqual(discovered.manifest);
    const persisted = await stored(db, id);
    expect(persisted.application_declaration).toEqual(discovered.manifest);
    expect(canonicalSha256(persisted.application_declaration)).toBe(`sha256:${discovered.digest}`);
  });
});
