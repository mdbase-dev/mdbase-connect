import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { runtimeConfigFromEnv } from "./runtime-config.js";
import { HostedProviderClient } from "./hosted-provider.js";

const port = Number(process.env.PORT ?? 8787);
const runtime = runtimeConfigFromEnv(process.env);
const db = await createDatabase();
const portalDist = process.env.PORTAL_DIST ?? resolve(import.meta.dirname, "../../../apps/portal/dist");
const { app } = await buildApp({
  db,
  publicUrl: runtime.publicUrl,
  portalDist,
  devAuth: runtime.devAuth,
  tailscaleAuth: runtime.tailscaleAuth,
  githubAuth: runtime.githubAuth ?? undefined,
  googleAuth: runtime.googleAuth ?? undefined,
  registration: runtime.registration,
  hostedCollections: runtime.hostedCollections,
  hostedProvider: runtime.hostedProvider
    ? new HostedProviderClient(runtime.hostedProvider)
    : undefined,
  trustProxy: runtime.trustProxy,
  allowInsecureManifests: process.env.MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS === "1"
});

await app.listen({ port, host: runtime.host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
