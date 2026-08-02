import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  ApplicationProvisions,
  ApplicationRequirements
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "../../db.js";
import type { RegisteredApplicationManifest } from "../../manifest.js";

export interface RegisteredApplication {
  id: string;
  manifest_digest: string;
  distribution: "web" | "portable";
  name: string;
  homepage: string;
  project_url: string | null;
  icon: string | null;
  redirect_uris: string[];
  canonical_identity: string;
  family_identity: string;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
}

export async function upsertApplication(
  db: DatabasePool,
  discovered: RegisteredApplicationManifest
): Promise<RegisteredApplication> {
  const application = await db.query<RegisteredApplication>(
    `INSERT INTO applications
       (id, canonical_identity, family_identity, manifest_version, manifest_digest,
        distribution, name, homepage,
        project_url, icon, redirect_uris, requirements, provisions, notifications)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
             $13::jsonb, $14::jsonb)
     ON CONFLICT(canonical_identity) DO UPDATE SET
       family_identity = excluded.family_identity,
       manifest_version = excluded.manifest_version,
       manifest_digest = excluded.manifest_digest,
       distribution = excluded.distribution,
       name = excluded.name,
       homepage = excluded.homepage,
       project_url = excluded.project_url,
       icon = excluded.icon,
       redirect_uris = excluded.redirect_uris,
       requirements = excluded.requirements,
       provisions = excluded.provisions,
       notifications = excluded.notifications,
       updated_at = now()
     RETURNING id, manifest_digest, distribution, name, homepage, project_url, icon, redirect_uris,
               canonical_identity, family_identity, requirements, provisions, notifications`,
    [
      randomUUID(),
      discovered.canonicalIdentity,
      discovered.familyIdentity,
      discovered.manifest.manifest_version,
      discovered.digest,
      discovered.manifest.distribution === "portable" ? "portable" : "web",
      discovered.manifest.name,
      discovered.manifest.distribution === "portable"
        ? ""
        : discovered.manifest.homepage,
      discovered.manifest.distribution === "portable"
        ? discovered.manifest.project_url ?? null
        : null,
      discovered.manifest.icon ?? null,
      JSON.stringify(
        discovered.manifest.distribution === "portable"
          ? []
          : discovered.manifest.redirect_uris
      ),
      JSON.stringify(discovered.manifest.requirements),
      JSON.stringify(discovered.manifest.provisions),
      JSON.stringify(discovered.manifest.notifications)
    ]
  );
  return application.rows[0];
}
