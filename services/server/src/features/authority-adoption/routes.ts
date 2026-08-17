import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { reconcileHostedAccount } from "../../entitlements.js";
import {
  HostedProviderResponseError,
  type HostedProviderClient
} from "../../hosted-provider.js";
import { randomToken, tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { authorityImportCapability } from "../../platform/authority-url.js";
import {
  apiError,
  RequestValidationError
} from "../../platform/http-errors.js";
import {
  bearerToken,
  requireUser
} from "../../platform/request-authentication.js";
import {
  authorityAdoptionBySecret,
  authorityAdoptionSelect,
  authorityAdoptionView,
  recoverExpiredAuthorityAdoptions,
  type AuthorityAdoptionRow
} from "./adoption-store.js";

interface AuthorityAdoptionRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
}

export function registerAuthorityAdoptionRoutes(
  app: FastifyInstance,
  options: AuthorityAdoptionRoutesOptions
): void {
  app.post("/v1/authority-adoptions", async (request, reply) => {
    if (!options.hostedCollections || !options.hostedProvider) {
      return adoptionUnavailable(reply);
    }
    await recoverExpiredAuthorityAdoptions(
      options.db,
      options.hostedProvider
    );
    const input = z.object({
      collection_id: z.uuid(),
      display_name: z.string().trim().min(1).max(200),
      source_name: z.string().trim().min(1).max(200),
      retain_mirror: z.boolean().default(true),
      mirror_name: z.string().trim().min(1).max(200).optional()
    }).strict().parse(request.body);
    const id = randomUUID();
    const secret = randomToken("adp");
    const expiresIn = 30 * 60;
    await options.db.query(
      `INSERT INTO authority_adoption_requests
         (id, secret_hash, collection_id, display_name, source_name,
          retain_mirror, mirror_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 minutes')`,
      [
        id,
        tokenHash(secret),
        input.collection_id,
        input.display_name,
        input.source_name,
        input.retain_mirror,
        input.retain_mirror
          ? (input.mirror_name ?? input.source_name)
          : null
      ]
    );
    return reply.code(201).send({
      adoption_id: id,
      adoption_secret: secret,
      verification_uri: `${options.publicUrl}/adopt/${id}`,
      expires_in: expiresIn
    });
  });

  app.get("/v1/authority-adoptions/:adoptionId", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const { adoptionId } = z.object({
      adoptionId: z.uuid()
    }).parse(request.params);
    await recoverExpiredAuthorityAdoptions(
      options.db,
      options.hostedProvider
    );
    const found = await options.db.query<AuthorityAdoptionRow>(
      `${authorityAdoptionSelect()}
       WHERE adoption.id = $1
         AND (
           adoption.expires_at > now()
           OR adoption.state NOT IN ('requested', 'approved', 'prepared')
         )
         AND (adoption.user_id IS NULL OR adoption.user_id = $2)`,
      [adoptionId, user.id]
    );
    const adoption = found.rows[0];
    if (!adoption) {
      return reply.code(404).send(apiError(
        "authority_adoption_not_found",
        "Collection adoption expired or was not found."
      ));
    }
    return { adoption: authorityAdoptionView(adoption) };
  });

  app.post(
    "/v1/authority-adoptions/:adoptionId/approve",
    async (request, reply) => {
      if (!options.hostedCollections || !options.hostedProvider) {
        return adoptionUnavailable(reply);
      }
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { adoptionId } = z.object({
        adoptionId: z.uuid()
      }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      await recoverExpiredAuthorityAdoptions(
        options.db,
        options.hostedProvider
      );
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const locked = await connection.query<AuthorityAdoptionRow>(
          `${authorityAdoptionSelect()}
           WHERE adoption.id = $1 FOR UPDATE`,
          [adoptionId]
        );
        const adoption = locked.rows[0];
        if (
          !adoption
          || (adoption.user_id !== null && adoption.user_id !== user.id)
          || new Date(adoption.expires_at).getTime() <= Date.now()
        ) {
          await connection.query("ROLLBACK");
          return reply.code(404).send(apiError(
            "authority_adoption_not_found",
            "Collection adoption expired or was not found."
          ));
        }
        if (adoption.state !== "requested") {
          await connection.query("COMMIT");
          if (
            [
              "approved",
              "prepared",
              "activating",
              "completed"
            ].includes(adoption.state)
          ) {
            return { adoption: authorityAdoptionView(adoption) };
          }
          return reply.code(409).send(apiError(
            "authority_adoption_inactive",
            "Collection adoption is no longer awaiting approval."
          ));
        }
        const hosted = await connection.query<{ id: string }>(
          `INSERT INTO hosted_collections
             (id, user_id, display_name, template, provider_url, contracts,
              authority_state, authority_epoch)
           VALUES ($1, $2, $3, 'mdbase', $4, '[]'::jsonb, 'importing', $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            adoption.collection_id,
            user.id,
            adoption.display_name,
            options.hostedProvider.url,
            Number(adoption.next_authority_epoch)
          ]
        );
        if (!hosted.rows[0]) {
          await connection.query("ROLLBACK");
          return reply.code(409).send(apiError(
            "authority_adoption_collection_conflict",
            "A hosted collection already uses this collection identity."
          ));
        }
        if (adoption.retain_mirror) {
          await connection.query(
            `INSERT INTO mirror_pairing_requests
               (id, secret_hash, mirror_name, mode, user_id, collection_hint,
                collection_id, approved_at, expires_at)
             VALUES (
               $1, $2, $3, 'read_write', $4, $5, $5, now(),
               now() + interval '24 hours'
             )`,
            [
              adoption.id,
              adoption.secret_hash,
              adoption.mirror_name ?? adoption.source_name,
              user.id,
              adoption.collection_id
            ]
          );
        }
        const approved = await connection.query<AuthorityAdoptionRow>(
          `UPDATE authority_adoption_requests
           SET user_id = $2, state = 'approved', approved_at = now()
           WHERE id = $1 AND state = 'requested'
           RETURNING *`,
          [adoptionId, user.id]
        );
        await audit(
          connection,
          user.id,
          "authority_adoption.approved",
          adoptionId,
          {
            collection_id: adoption.collection_id,
            retain_mirror: adoption.retain_mirror
          }
        );
        await connection.query("COMMIT");
        return { adoption: authorityAdoptionView(approved.rows[0]) };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    "/v1/authority-adoptions/:adoptionId/exchange",
    async (request, reply) => {
      if (!options.hostedCollections || !options.hostedProvider) {
        return adoptionUnavailable(reply);
      }
      const { adoptionId } = z.object({
        adoptionId: z.uuid()
      }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      const secret = bearerToken(request);
      if (!secret) {
        return reply.code(401).send(apiError(
          "invalid_authority_adoption",
          "Collection adoption credential required."
        ));
      }
      await recoverExpiredAuthorityAdoptions(
        options.db,
        options.hostedProvider
      );
      const adoption = await authorityAdoptionBySecret(
        options.db,
        adoptionId,
        secret
      );
      if (!adoption) {
        return reply.code(404).send(apiError(
          "authority_adoption_not_found",
          "Collection adoption expired or was not found."
        ));
      }
      if (adoption.state === "requested") {
        return reply.code(202).send({ status: "pending" });
      }
      if (adoption.state === "completed") {
        return {
          status: "completed",
          adoption: authorityAdoptionView(adoption)
        };
      }
      if (adoption.state === "activating") {
        return {
          status: "activating",
          adoption: authorityAdoptionView(adoption)
        };
      }
      if (adoption.state === "expired") {
        return reply.code(409).send(apiError(
          "authority_adoption_expired",
          "Collection adoption expired before hosted activation began."
        ));
      }
      if (adoption.state === "cancelled") {
        return reply.code(409).send(apiError(
          "authority_adoption_cancelled",
          "Collection adoption was cancelled before hosted activation began."
        ));
      }
      if (!["approved", "prepared"].includes(adoption.state)) {
        return reply.code(409).send(apiError(
          "authority_adoption_inactive",
          "Collection adoption is no longer active."
        ));
      }
      const importToken = randomToken("ati");
      if (!adoption.user_id) {
        throw new RequestValidationError(
          "Collection adoption has not been assigned to an account."
        );
      }
      const account = await reconcileHostedAccount(
        options.db,
        options.hostedProvider,
        adoption.user_id
      );
      const prepared = await options.hostedProvider.prepareAuthorityImport({
        transferId: adoption.id,
        accountId: account.providerAccountId,
        collectionId: adoption.collection_id,
        displayName: adoption.display_name,
        token: importToken,
        authorityEpoch: Number(adoption.next_authority_epoch),
        ttlSeconds: 30 * 60
      });
      const saved = await options.db.query<AuthorityAdoptionRow>(
        `UPDATE authority_adoption_requests
         SET state = 'prepared',
             prepared_at = COALESCE(prepared_at, now()),
             expires_at = $2
         WHERE id = $1 AND state IN ('approved', 'prepared')
         RETURNING *`,
        [adoption.id, prepared.expires_at]
      );
      if (!saved.rows[0]) {
        return reply.code(409).send(apiError(
          "authority_adoption_state_changed",
          "Collection adoption changed state while upload access was prepared."
        ));
      }
      return {
        status: "ready",
        adoption: authorityAdoptionView(saved.rows[0]),
        staged: {
          state: prepared.state,
          manifest_digest: prepared.manifest_digest,
          source_revision: prepared.source_revision,
          source_head: prepared.source_head
        },
        import: authorityImportCapability(
          options.hostedProvider.url,
          adoption.id,
          importToken
        )
      };
    }
  );

  app.post(
    "/v1/authority-adoptions/:adoptionId/complete",
    async (request, reply) => {
      if (!options.hostedProvider) {
        return adoptionUnavailable(reply);
      }
      const { adoptionId } = z.object({
        adoptionId: z.uuid()
      }).parse(request.params);
      const secret = bearerToken(request);
      if (!secret) {
        return reply.code(401).send(apiError(
          "invalid_authority_adoption",
          "Collection adoption credential required."
        ));
      }
      const input = z.object({
        manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
        source_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        source_head: z.number().int().nonnegative()
      }).strict().parse(request.body);
      const adoption = await authorityAdoptionBySecret(
        options.db,
        adoptionId,
        secret
      );
      if (!adoption) {
        return reply.code(404).send(apiError(
          "authority_adoption_not_found",
          "Collection adoption was not found."
        ));
      }
      if (adoption.state === "completed") {
        if (!matchesSnapshot(adoption, input)) {
          return reply.code(409).send(apiError(
            "authority_adoption_snapshot_mismatch",
            "Completed adoption belongs to a different source snapshot."
          ));
        }
        return {
          status: "completed",
          adoption: authorityAdoptionView(adoption)
        };
      }
      if (
        !["prepared", "activating"].includes(adoption.state)
        || (
          adoption.state === "prepared"
          && new Date(adoption.expires_at).getTime() <= Date.now()
        )
      ) {
        return reply.code(409).send(apiError(
          "authority_adoption_inactive",
          "Collection adoption is no longer prepared."
        ));
      }
      if (adoption.state === "activating" && !matchesSnapshot(adoption, input)) {
        return reply.code(409).send(apiError(
          "authority_adoption_snapshot_mismatch",
          "Authority activation must resume with the same fenced source snapshot."
        ));
      }
      if (adoption.state === "prepared") {
        const reserved = await options.db.query(
          `UPDATE authority_adoption_requests
           SET state = 'activating', manifest_digest = $2,
               source_revision = $3, final_head = $4
           WHERE id = $1 AND state = 'prepared'`,
          [
            adoption.id,
            input.manifest_digest,
            input.source_revision,
            input.source_head
          ]
        );
        if (reserved.rowCount !== 1) {
          return reply.code(409).send(apiError(
            "authority_adoption_state_changed",
            "Collection adoption changed state while activation was reserved."
          ));
        }
      }
      let completed;
      try {
        completed = await options.hostedProvider.completeAuthorityImport(
          adoption.id,
          input.manifest_digest,
          input.source_revision
        );
      } catch (error) {
        if (
          error instanceof HostedProviderResponseError
          && error.code === "projection_activation_pending"
        ) {
          return reply.code(202).send({ status: "activating" });
        }
        throw error;
      }
      if (
        completed.id !== adoption.id
        || completed.collection_id !== adoption.collection_id
        || completed.state !== "completed"
        || completed.authority_epoch !== Number(adoption.next_authority_epoch)
        || completed.manifest_digest !== input.manifest_digest
        || completed.source_revision !== input.source_revision
        || completed.source_head !== input.source_head
      ) {
        throw new RequestValidationError(
          "The hosted authority activated a different adoption snapshot."
        );
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const current = await connection.query<AuthorityAdoptionRow>(
          `${authorityAdoptionSelect()}
           WHERE adoption.id = $1 FOR UPDATE`,
          [adoption.id]
        );
        if (current.rows[0]?.state === "completed") {
          await connection.query("COMMIT");
          return {
            status: "completed",
            adoption: authorityAdoptionView(current.rows[0])
          };
        }
        if (current.rows[0]?.state !== "activating") {
          throw new RequestValidationError(
            "Collection adoption is not reserved for activation."
          );
        }
        const activated = await connection.query(
          `UPDATE hosted_collections
           SET authority_state = 'active', authority_epoch = $2,
               contracts = $3::jsonb
           WHERE id = $1 AND authority_state = 'importing'`,
          [
            adoption.collection_id,
            completed.authority_epoch,
            JSON.stringify(completed.contracts)
          ]
        );
        const committed = await connection.query<AuthorityAdoptionRow>(
          `UPDATE authority_adoption_requests
           SET state = 'completed', contracts = $2::jsonb,
               completed_at = now()
           WHERE id = $1 AND state = 'activating'
           RETURNING *`,
          [adoption.id, JSON.stringify(completed.contracts)]
        );
        if (activated.rowCount !== 1 || !committed.rows[0]) {
          throw new RequestValidationError(
            "Authority metadata changed while adoption completed."
          );
        }
        await audit(
          connection,
          adoption.user_id!,
          "authority_adoption.completed",
          adoption.id,
          {
            collection_id: adoption.collection_id,
            authority_epoch: completed.authority_epoch,
            retain_mirror: adoption.retain_mirror
          }
        );
        await connection.query("COMMIT");
        return {
          status: "completed",
          adoption: authorityAdoptionView(committed.rows[0])
        };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
  );

  app.delete(
    "/v1/authority-adoptions/:adoptionId",
    async (request, reply) => {
      if (!options.hostedProvider) {
        return adoptionUnavailable(reply);
      }
      const { adoptionId } = z.object({
        adoptionId: z.uuid()
      }).parse(request.params);
      const secret = bearerToken(request);
      if (!secret) {
        return reply.code(401).send(apiError(
          "invalid_authority_adoption",
          "Collection adoption credential required."
        ));
      }
      const adoption = await authorityAdoptionBySecret(
        options.db,
        adoptionId,
        secret
      );
      if (!adoption) {
        return reply.code(404).send(apiError(
          "authority_adoption_not_found",
          "Collection adoption was not found."
        ));
      }
      if (adoption.state === "completed") {
        return reply.code(409).send(apiError(
          "authority_adoption_completed",
          "Completed collection adoption cannot be cancelled."
        ));
      }
      if (adoption.state === "activating") {
        return reply.code(409).send(apiError(
          "authority_adoption_activation_started",
          "Hosted authority activation has started and can no longer be cancelled."
        ));
      }
      if (adoption.state !== "cancelled") {
        const cancelled = await options.db.query(
          `UPDATE authority_adoption_requests
           SET state = 'cancelled', cancelled_at = now()
           WHERE id = $1
             AND state IN ('requested', 'approved', 'prepared', 'expired')`,
          [adoption.id]
        );
        if (cancelled.rowCount !== 1) {
          return reply.code(409).send(apiError(
            "authority_adoption_state_changed",
            "Collection adoption changed state while cancellation was reserved."
          ));
        }
      }
      try {
        await options.hostedProvider.abortAuthorityImport(adoption.id);
      } catch (error) {
        if (!ignorableAbortError(error)) {
          throw error;
        }
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "DELETE FROM mirror_pairing_requests WHERE id = $1",
          [adoption.id]
        );
        await connection.query(
          `DELETE FROM hosted_collections
           WHERE id = $1 AND authority_state = 'importing'`,
          [adoption.collection_id]
        );
        if (adoption.user_id) {
          await audit(
            connection,
            adoption.user_id,
            "authority_adoption.cancelled",
            adoption.id,
            { collection_id: adoption.collection_id }
          );
        }
        await connection.query("COMMIT");
        return { ok: true };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
  );
}

function adoptionUnavailable(reply: {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
}): unknown {
  return reply.code(404).send(apiError(
    "hosted_adoption_unavailable",
    "This Connect server cannot adopt local collections."
  ));
}

function matchesSnapshot(
  adoption: AuthorityAdoptionRow,
  input: {
    manifest_digest: string;
    source_revision: string;
    source_head: number;
  }
): boolean {
  return adoption.manifest_digest === input.manifest_digest
    && adoption.source_revision === input.source_revision
    && Number(adoption.final_head) === input.source_head;
}

function ignorableAbortError(error: unknown): boolean {
  return error instanceof HostedProviderResponseError
    && [
      "authority_import_not_found",
      "authority_import_inactive"
    ].includes(error.code);
}
