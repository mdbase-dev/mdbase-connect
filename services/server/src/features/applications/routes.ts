import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../db.js";
import { registerApplicationManifest } from "../../manifest.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";
import { reconcileApplicationGrants } from "../grants/service.js";
import { upsertApplication } from "./store.js";

interface ApplicationRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  hostedProvider?: HostedProviderClient;
  allowInsecureManifests?: boolean;
}

export function registerApplicationRoutes(
  app: FastifyInstance,
  options: ApplicationRouteOptions
): void {
  app.post("/v1/apps/validate", async (request) => {
    const input = z.object({ manifest: z.unknown() }).strict().parse(request.body);
    const validated = registerApplicationManifest(
      input.manifest,
      options.allowInsecureManifests
    );
    return {
      valid: true,
      declaration: {
        manifest_digest: validated.digest,
        canonical_identity: validated.canonicalIdentity,
        family_identity: validated.familyIdentity
      }
    };
  });

  app.post("/v1/apps/register", async (request) => {
    const input = z.object({ manifest: z.unknown() }).strict().parse(request.body);
    const registered = registerApplicationManifest(
      input.manifest,
      options.allowInsecureManifests
    );
    const application = await upsertApplication(options.db, registered);
    await reconcileApplicationGrants(
      options.db,
      options.relay,
      options.hostedProvider,
      application
    );
    return { application };
  });
}
