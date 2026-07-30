import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";

export interface SystemRoutesOptions {
  db: DatabasePool;
  relay: Pick<RelayHub, "ready">;
  hostedCollections: boolean;
  hostedProvider?: Pick<HostedProviderClient, "ready">;
  revision?: string;
}

export function registerSystemRoutes(
  app: FastifyInstance,
  options: SystemRoutesOptions
): void {
  const revision = options.revision?.trim() || undefined;

  app.get("/health", async () => ({
    ok: true,
    service: "mdbase-connect",
    protocol_version: 1,
    ...(revision ? { revision } : {})
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      await options.db.query("SELECT 1");
      await options.relay.ready();
      if (options.hostedCollections && options.hostedProvider) {
        await options.hostedProvider.ready();
      }
      return { ok: true, service: "mdbase-connect" };
    } catch {
      return reply.code(503).send({
        ok: false,
        service: "mdbase-connect"
      });
    }
  });
}
