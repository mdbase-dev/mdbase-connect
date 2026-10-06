import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken, requireConnector } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { ApprovalPeerInputError } from "./approval-peer.js";
import { queueApprovalPeer, readApprovalPeers } from "./approval-peer-store.js";
import { refuse } from "./bootstrap-common.js";

const proof = z.object({ device_id: z.uuid(), challenge: z.string().regex(/^[0-9a-f]{64}$/), sig: z.string().regex(/^[0-9a-f]{128}$/) }).strict();
const send = z.object({ peer: z.string().min(1).max(2731).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const ack = proof.extend({ ids: z.array(z.uuid()).min(1).max(16).refine(ids => new Set(ids).size === ids.length) });
/** Mounted only in the existing configured NEXT device feature. No app/service route. */
export function registerApprovalPeerRoutes(app: FastifyInstance, db: DatabasePool): void {
  const prefix = "/v1/next/collections/:collection/device-approval";
  const bounded = { bodyLimit: 8192, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  for (const action of ["peer", "inbox", "ack"] as const) {
    app.post(`${prefix}/${action}`, bounded, async (request, reply) => {
      const connector = await requireConnector(request, reply, db);
      if (!connector) return reply;
      reply.header("cache-control", "no-store");
      const path = z.object({ collection: z.uuid() }).safeParse(request.params);
      const body = (action === "peer" ? send : action === "inbox" ? proof : ack).safeParse(request.body);
      if (!path.success || !body.success) return reply.code(400).send(apiError("invalid_peer", "Invalid approval peer metadata."));
      try {
        const hash = tokenHash(bearerToken(request)!);
        if (action === "peer") {
          const text = (body.data as z.infer<typeof send>).peer;
          const bytes = Buffer.from(text, "base64url");
          if (bytes.length > 2048 || bytes.toString("base64url") !== text) throw new ApprovalPeerInputError();
          return await queueApprovalPeer(db, connector, hash, path.data.collection, bytes);
        }
        const p = body.data as z.infer<typeof ack>;
        return await readApprovalPeers(db, connector, hash, path.data.collection, p, action === "ack" ? p.ids : undefined);
      } catch (error) {
        if (error instanceof ApprovalPeerInputError) return reply.code(400).send(apiError("invalid_peer", error.message));
        return refuse(reply, error, "Approval peer metadata is unavailable.");
      }
    });
  }
}
