import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createDatabase, openDatabase } from "./db.js";
import { assertControlPlaneMigrationsCurrent } from "./migrations.js";
import { runtimeConfigFromEnv } from "./runtime-config.js";
import { HostedProviderClient } from "./hosted-provider.js";
import { createRelayBroker } from "./relay-broker.js";
import { WebPushTransport } from "./web-push.js";
import { FcmTransport } from "./fcm.js";
import { SignedWebhookTransport } from "./webhook.js";
import { ResendEmailTransport } from "./email.js";

const port = Number(process.env.PORT ?? 8787);
const runtime = runtimeConfigFromEnv(process.env);
const db = process.env.NODE_ENV === "production"
  ? await openDatabase()
  : await createDatabase();
if (process.env.NODE_ENV === "production") {
  await assertControlPlaneMigrationsCurrent(db);
}
const relayBroker = await createRelayBroker(runtime.relayBroker);
const portalDist = process.env.PORTAL_DIST ?? resolve(import.meta.dirname, "../../../apps/portal/dist");
const { app } = await buildApp({
  db,
  revision: process.env.RENDER_GIT_COMMIT,
  publicUrl: runtime.publicUrl,
  portalDist,
  devAuth: runtime.devAuth,
  tailscaleAuth: runtime.tailscaleAuth,
  githubAuth: runtime.githubAuth ?? undefined,
  googleAuth: runtime.googleAuth ?? undefined,
  registration: runtime.registration,
  authRateLimitSecret: runtime.authRateLimitSecret ?? undefined,
  betaAccessOrigin: runtime.betaAccessOrigin ?? undefined,
  managementOrigins: runtime.managementOrigins,
  editorOrigin: runtime.editorOrigin ?? undefined,
  authenticationLegalDocuments:
    runtime.authenticationLegalDocuments ?? undefined,
  emailTransport: runtime.transactionalEmail
    ? new ResendEmailTransport(runtime.transactionalEmail)
    : undefined,
  resendWebhookSecret: runtime.resendWebhookSecret ?? undefined,
  hostedCollections: runtime.hostedCollections,
  hostedReferenceAuthority: runtime.hostedReferenceAuthority,
  hostedProvider: runtime.hostedProvider
    ? new HostedProviderClient(runtime.hostedProvider)
    : undefined,
  trustProxy: runtime.trustProxy,
  allowInsecureManifests: process.env.MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS === "1",
  relayBroker,
  notifications: runtime.vapid || runtime.fcm || runtime.webhookSigning
    ? {
        ...(runtime.vapid ? { publicKey: runtime.vapid.publicKey } : {}),
        transports: {
          ...(runtime.vapid
            ? { webPush: new WebPushTransport(runtime.vapid) }
            : {}),
          ...(runtime.fcm
            ? { fcm: new FcmTransport({
                ...(runtime.fcm.credentials
                  ? { credentials: runtime.fcm.credentials }
                  : {})
              }) }
            : {}),
          ...(runtime.webhookSigning
            ? { webhook: new SignedWebhookTransport(runtime.webhookSigning) }
            : {})
        }
      }
    : undefined
});

await app.listen({ port, host: runtime.host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
