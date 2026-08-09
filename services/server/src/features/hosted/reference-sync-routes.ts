import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import {
  asSyncMutation,
  type HostedAuthorityRegistry
} from "../../hosted.js";
import { apiError } from "../../platform/http-errors.js";
import { requireHostedReplica } from "./service.js";

interface ReferenceSyncRoutesOptions {
  db: DatabasePool;
  hostedReference?: HostedAuthorityRegistry;
}

const syncMutationBase = z.object({
  mutation_id: z.uuid(),
  replica_id: z.uuid(),
  scope_epoch: z.number().int().positive(),
  record_id: z.uuid(),
  created_at: z.iso.datetime(),
  causal_predecessor: z.uuid().optional()
});

const syncMutationSchema = z.discriminatedUnion("operation", [
  syncMutationBase.extend({
    operation: z.literal("put"),
    base_revision: z.string().min(1).optional(),
    path: z.string().min(1),
    document: z.string()
  }).strict(),
  syncMutationBase.extend({
    operation: z.literal("move"),
    base_revision: z.string().min(1),
    path: z.string().min(1)
  }).strict(),
  syncMutationBase.extend({
    operation: z.literal("delete"),
    base_revision: z.string().min(1)
  }).strict()
]);

export function registerReferenceSyncRoutes(
  app: FastifyInstance,
  options: ReferenceSyncRoutesOptions
): void {
  app.get(
    "/v1/authorities/:collectionId/files",
    async (request, reply) => {
      const scoped = await scopedReplica(request, reply, options);
      if (!scoped) return;
      z.object({
        protocol_version: z.coerce.number().int().min(1).max(1),
        folder: z.string().optional(),
        after: z.string().optional(),
        limit: z.coerce.number().int().positive().max(1_000).optional()
      }).parse(request.query);
      return {
        protocol_version: 1,
        type: "files_page",
        files: []
      };
    }
  );

  app.post(
    "/v1/authorities/:collectionId/sync/sessions",
    async (request, reply) => {
      const scoped = await scopedReplica(request, reply, options);
      if (!scoped) return;
      return (
        await options.hostedReference!.transport(
          scoped.collectionId,
          scoped.replicaId
        )
      ).openSession();
    }
  );

  app.get(
    "/v1/authorities/:collectionId/sync/snapshot",
    async (request, reply) => {
      const scoped = await scopedReplica(request, reply, options);
      if (!scoped) return;
      const query = z.object({
        snapshot_id: z.uuid(),
        page: z.string().regex(/^[1-9][0-9]*$/).optional()
      }).parse(request.query);
      return (
        await options.hostedReference!.transport(
          scoped.collectionId,
          scoped.replicaId
        )
      ).snapshot(query.snapshot_id, query.page);
    }
  );

  app.get(
    "/v1/authorities/:collectionId/sync/files/snapshot",
    async (request, reply) => {
      const scoped = await scopedReplica(request, reply, options);
      if (!scoped) return;
      const query = z.object({
        snapshot_id: z.uuid(),
        page: z.string().regex(/^[1-9][0-9]*$/).optional()
      }).parse(request.query);
      return (
        await options.hostedReference!.transport(
          scoped.collectionId,
          scoped.replicaId
        )
      ).fileSnapshot(query.snapshot_id, query.page);
    }
  );

  app.get(
    "/v1/authorities/:collectionId/sync/changes",
    async (request, reply) => {
      const scoped = await scopedReplica(request, reply, options);
      if (!scoped) return;
      const query = z.object({
        after: z.coerce.number().int().nonnegative(),
        limit: z.coerce.number().int().positive().max(500).default(200)
      }).parse(request.query);
      return (
        await options.hostedReference!.transport(
          scoped.collectionId,
          scoped.replicaId
        )
      ).changes(query.after, query.limit);
    }
  );

  app.post(
    "/v1/authorities/:collectionId/sync/mutations",
    async (request, reply) => {
      const scoped = await scopedReplica(request, reply, options);
      if (!scoped) return;
      const mutation = syncMutationSchema.parse(request.body);
      if (mutation.replica_id !== scoped.replicaId) {
        return reply.code(403).send(apiError(
          "replica_scope_denied",
          "Mutation belongs to another replica."
        ));
      }
      return (
        await options.hostedReference!.transport(
          scoped.collectionId,
          scoped.replicaId
        )
      ).mutate(asSyncMutation(mutation));
    }
  );
}

async function scopedReplica(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReferenceSyncRoutesOptions
): Promise<{ collectionId: string; replicaId: string } | null> {
  const replica = await requireHostedReplica(request, reply, options.db);
  if (!replica) return null;
  const { collectionId } = z.object({
    collectionId: z.uuid()
  }).parse(request.params);
  if (collectionId !== replica.collection_id) {
    reply.code(403).send(apiError(
      "replica_scope_denied",
      "Replica belongs to another collection."
    ));
    return null;
  }
  return { collectionId, replicaId: replica.id };
}
