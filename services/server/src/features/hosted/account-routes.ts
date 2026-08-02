import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveHostedCollectionAccess } from "../../collection-access.js";
import {
  type HostedAuthorityRegistry
} from "../../hosted.js";
import { randomToken, tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { authorityUrl } from "../../platform/authority-url.js";
import { apiError } from "../../platform/http-errors.js";
import { requireUser } from "../../platform/request-authentication.js";
import {
  createHostedCollectionForUser,
  canManageHostedReplica,
  permitsHostedCollectionAction,
  type HostedServiceOptions
} from "./service.js";

interface HostedAccountRoutesOptions extends HostedServiceOptions {
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedReference?: HostedAuthorityRegistry;
}

export function registerHostedAccountRoutes(
  app: FastifyInstance,
  options: HostedAccountRoutesOptions
): void {
  app.post("/v1/hosted/collections", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const input = z.object({
      display_name: z.string().trim().min(1).max(200),
      template: z.literal("mdbase").default("mdbase")
    }).strict().parse(request.body);
    const collection = await createHostedCollectionForUser(
      options,
      options.hostedReference,
      options.publicUrl,
      user.id,
      input.display_name,
      input.template
    );
    const collectionId = String(collection.id);
    return reply.code(201).send({
      collection: {
        id: collectionId,
        display_name: input.display_name,
        template: input.template,
        spec_version: "0.3.0",
        sync_url: authorityUrl(
          options.hostedProvider?.url ?? options.publicUrl,
          collectionId,
          "sync"
        )
      }
    });
  });

  app.post(
    "/v1/hosted/collections/:collectionId/replicas",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        name: z.string().trim().min(1).max(200),
        mode: z.enum(["read_only", "read_write"]),
        allowed_types: z.array(
          z.string().min(1).max(100)
        ).max(100).default([])
      }).strict().parse(request.body);
      if (!await permitsHostedCollectionAction(
        options.db,
        user.id,
        collectionId,
        "mirror.enroll",
        true
      )) {
        return hostedCollectionNotFound(reply);
      }
      const replicaId = randomUUID();
      const token = randomToken("hsr");
      if (options.hostedProvider) {
        await options.hostedProvider.registerReplica(collectionId, {
          id: replicaId,
          name: input.name,
          mode: input.mode,
          allowedTypes: input.allowed_types,
          token
        });
      } else {
        await options.hostedReference!.registerReplica(collectionId, {
          id: replicaId,
          name: input.name,
          mode: input.mode,
          allowedTypes: input.allowed_types
        });
      }
      try {
        await options.db.query(
          `INSERT INTO hosted_replicas
             (id, collection_id, authorized_user_id, name, mode,
              allowed_types, token_hash)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            replicaId,
            collectionId,
            user.id,
            input.name,
            input.mode,
            JSON.stringify(input.allowed_types),
            options.hostedProvider ? null : tokenHash(token)
          ]
        );
      } catch (error) {
        if (options.hostedProvider) {
          await options.hostedProvider.revokeReplica(replicaId);
        } else {
          await options.hostedReference!.revokeReplica(
            collectionId,
            replicaId
          );
        }
        throw error;
      }
      await audit(
        options.db,
        user.id,
        "hosted_replica.created",
        replicaId,
        {
          collection_id: collectionId,
          mode: input.mode,
          allowed_types: input.allowed_types
        }
      );
      return reply.code(201).send({
        replica: {
          id: replicaId,
          collection_id: collectionId,
          name: input.name,
          mode: input.mode
        },
        token,
        sync_url: authorityUrl(
          options.hostedProvider?.url ?? options.publicUrl,
          collectionId,
          "sync"
        )
      });
    }
  );

  app.patch(
    "/v1/hosted/collections/:collectionId",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        display_name: z.string().trim().min(1).max(200)
      }).strict().parse(request.body);
      if (!await permitsHostedCollectionAction(
        options.db,
        user.id,
        collectionId,
        "collection.rename"
      )) {
        return hostedCollectionNotFound(reply);
      }
      if (options.hostedProvider) {
        await options.hostedProvider.renameCollection(
          collectionId,
          input.display_name
        );
      }
      const renamed = await options.db.query<{
        id: string;
        display_name: string;
      }>(
        `UPDATE hosted_collections SET display_name = $3
         WHERE id = $1 AND user_id = $2
         RETURNING id, display_name`,
        [collectionId, user.id, input.display_name]
      );
      if (!renamed.rows[0]) {
        return hostedCollectionNotFound(reply);
      }
      await audit(
        options.db,
        user.id,
        "hosted_collection.renamed",
        collectionId,
        { display_name: input.display_name }
      );
      return { collection: renamed.rows[0] };
    }
  );

  app.delete(
    "/v1/hosted/collections/:collectionId",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      if (!await permitsHostedCollectionAction(
        options.db,
        user.id,
        collectionId,
        "collection.delete"
      )) {
        return hostedCollectionNotFound(reply);
      }
      if (options.hostedProvider) {
        await options.hostedProvider.deleteCollection(collectionId);
      } else {
        await options.hostedReference!.delete(collectionId);
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          `DELETE FROM grants
           WHERE hosted_collection_id = $1 AND user_id = $2`,
          [collectionId, user.id]
        );
        await connection.query(
          `DELETE FROM hosted_collections
           WHERE id = $1 AND user_id = $2`,
          [collectionId, user.id]
        );
        await audit(
          connection,
          user.id,
          "hosted_collection.deleted",
          collectionId,
          {}
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
      return { ok: true };
    }
  );

  app.post(
    "/v1/hosted/replicas/:replicaId/token",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { replicaId } = z.object({
        replicaId: z.uuid()
      }).parse(request.params);
      const active = await activeReplicaForUser(
        options,
        user.id,
        replicaId
      );
      if (!active) {
        return replicaNotFound(reply);
      }
      const token = randomToken("hsr");
      if (options.hostedProvider) {
        await options.hostedProvider.rotateReplicaToken(replicaId, token);
      } else {
        await options.db.query(
          `UPDATE hosted_replicas SET token_hash = $2
           WHERE id = $1`,
          [replicaId, tokenHash(token)]
        );
      }
      return {
        token,
        sync_url: authorityUrl(
          options.hostedProvider?.url ?? options.publicUrl,
          active.collection_id,
          "sync"
        )
      };
    }
  );

  app.delete(
    "/v1/hosted/replicas/:replicaId",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { replicaId } = z.object({
        replicaId: z.uuid()
      }).parse(request.params);
      const active = await activeReplicaForUser(
        options,
        user.id,
        replicaId
      );
      if (!active) {
        return replicaNotFound(reply);
      }
      if (options.hostedProvider) {
        await options.hostedProvider.revokeReplica(replicaId);
      } else {
        await options.hostedReference!.revokeReplica(
          active.collection_id,
          replicaId
        );
      }
      await options.db.query(
        `UPDATE hosted_replicas
         SET revoked_at = now(), token_hash = NULL
         WHERE id = $1`,
        [replicaId]
      );
      await options.db.query(
        "DELETE FROM mirror_pairing_requests WHERE replica_id = $1",
        [replicaId]
      );
      await audit(
        options.db,
        user.id,
        "hosted_replica.revoked",
        replicaId,
        {}
      );
      return { ok: true };
    }
  );

  app.post(
    "/v1/hosted/collections/:collectionId/maintenance/compact",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        through: z.number().int().nonnegative()
      }).strict().parse(request.body);
      if (!await permitsHostedCollectionAction(
        options.db,
        user.id,
        collectionId,
        "schema.manage"
      )) {
        return hostedCollectionNotFound(reply);
      }
      if (options.hostedProvider) {
        await options.hostedProvider.compactThrough(
          collectionId,
          input.through
        );
      } else {
        await options.hostedReference!.compactThrough(
          collectionId,
          input.through
        );
      }
      return { ok: true };
    }
  );
}

async function activeReplicaForUser(
  options: HostedAccountRoutesOptions,
  userId: string,
  replicaId: string
): Promise<{
  id: string;
  collection_id: string;
  authorized_user_id: string | null;
} | null> {
  const active = await options.db.query<{
    id: string;
    collection_id: string;
    authorized_user_id: string | null;
  }>(
    `SELECT id, collection_id, authorized_user_id
     FROM hosted_replicas
     WHERE id = $1 AND revoked_at IS NULL`,
    [replicaId]
  );
  const replica = active.rows[0];
  const access = replica
    ? await resolveHostedCollectionAccess(
        options.db,
        userId,
        replica.collection_id
      )
    : null;
  if (
    !replica
    || !access
    || !canManageHostedReplica(access, replica.authorized_user_id)
  ) {
    return null;
  }
  return replica;
}

function hostedCollectionNotFound(reply: {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
}): unknown {
  return reply.code(404).send(apiError(
    "hosted_collection_not_found",
    "Hosted collection not found."
  ));
}

function replicaNotFound(reply: {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
}): unknown {
  return reply.code(404).send(apiError(
    "replica_not_found",
    "Active replica not found."
  ));
}
