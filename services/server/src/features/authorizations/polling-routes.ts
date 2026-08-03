import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AuthorityProofError,
  verifyAuthorityRequestProof
} from "../../authority-proof.js";
import {
  pkceChallenge,
  safeEqual,
  tokenHash
} from "../../security.js";
import { apiError, oauthError } from "../../platform/http-errors.js";
import type { AuthorizationRouteOptions } from "./route-options.js";
import { issueApplicationTokens } from "./token-service.js";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export function registerAuthorizationPollingRoutes(
  app: FastifyInstance,
  options: AuthorizationRouteOptions
): void {
  app.post("/oauth/token", async (request, reply) => {
    const input = z.discriminatedUnion("grant_type", [
      z.object({
        grant_type: z.literal("authorization_code"),
        code: z.string().min(1),
        client_id: z.uuid(),
        redirect_uri: z.url(),
        code_verifier: z.string().min(43).max(128)
      }),
      z.object({
        grant_type: z.literal("refresh_token"),
        refresh_token: z.string().min(1),
        client_id: z.uuid()
      }),
      z.object({
        grant_type: z.literal(DEVICE_GRANT_TYPE),
        device_code: z.string().min(1),
        client_id: z.uuid(),
        code_verifier: z.string().min(43).max(128)
      })
    ]).parse(request.body);

    if (input.grant_type === DEVICE_GRANT_TYPE) {
      reply.header("cache-control", "no-store");
      const device = await options.db.query<{
        id: string;
        application_id: string;
        grant_id: string | null;
        code_challenge: string;
        denied_at: string | null;
        completed_at: string | null;
        expires_at: string | Date;
        device_consumed_at: string | null;
      }>(
        `SELECT id, application_id, grant_id, code_challenge, denied_at,
                completed_at, expires_at, device_consumed_at
         FROM authorization_requests
         WHERE flow = 'device_code' AND device_code_hash = $1`,
        [tokenHash(input.device_code)]
      );
      const pending = device.rows[0];
      if (
        !pending
        || pending.application_id !== input.client_id
        || !safeEqual(pending.code_challenge, pkceChallenge(input.code_verifier))
        || pending.device_consumed_at
      ) {
        return reply.code(400).send(oauthError(
          "invalid_grant",
          "The device authorization is invalid or has already been used."
        ));
      }
      if (new Date(pending.expires_at).getTime() <= Date.now()) {
        return reply.code(400).send(oauthError(
          "expired_token",
          "The device authorization has expired."
        ));
      }
      const acceptedPoll = await options.db.query(
        `UPDATE authorization_requests SET last_polled_at = now()
         WHERE id = $1 AND device_consumed_at IS NULL
           AND (
             last_polled_at IS NULL
             OR last_polled_at <= now() - interval '5 seconds'
           )
         RETURNING id`,
        [pending.id]
      );
      if (!acceptedPoll.rows[0]) {
        return reply.code(400).send(oauthError(
          "slow_down",
          "Poll no more often than the interval returned by the device authorization endpoint."
        ));
      }
      if (pending.denied_at) {
        return reply.code(400).send(oauthError(
          "access_denied",
          "Collection access was not approved."
        ));
      }
      if (!pending.completed_at || !pending.grant_id) {
        return reply.code(400).send(oauthError(
          "authorization_pending",
          "The user has not completed the authorization request."
        ));
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const consumed = await connection.query<{ grant_id: string }>(
          `UPDATE authorization_requests SET device_consumed_at = now()
           WHERE id = $1 AND device_consumed_at IS NULL
           RETURNING grant_id`,
          [pending.id]
        );
        if (!consumed.rows[0]) {
          await connection.query("ROLLBACK");
          return reply.code(400).send(oauthError(
            "invalid_grant",
            "The device authorization has already been used."
          ));
        }
        const tokens = await issueApplicationTokens(
          connection,
          options.hostedProvider,
          consumed.rows[0].grant_id
        );
        await connection.query("COMMIT");
        return tokens;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }

    if (input.grant_type === "authorization_code") {
      const code = await options.db.query<{
        id: string;
        grant_id: string;
        application_id: string;
        redirect_uri: string;
        code_challenge: string;
      }>(
        `SELECT ac.id, ac.grant_id, ac.application_id, ac.redirect_uri,
                ac.code_challenge
         FROM authorization_codes ac
         JOIN grants g ON g.id = ac.grant_id
         JOIN users u ON u.id = g.user_id
         WHERE ac.code_hash = $1 AND ac.used_at IS NULL
           AND ac.expires_at > now() AND g.revoked_at IS NULL
           AND u.suspended_at IS NULL`,
        [tokenHash(input.code)]
      );
      const authorizationCode = code.rows[0];
      if (!authorizationCode
        || authorizationCode.application_id !== input.client_id
        || authorizationCode.redirect_uri !== input.redirect_uri
        || !safeEqual(authorizationCode.code_challenge, pkceChallenge(input.code_verifier))) {
        return reply.code(400).send(apiError("invalid_grant", "Authorization code is invalid or expired."));
      }
      const consumed = await options.db.query(
        "UPDATE authorization_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
        [authorizationCode.id]
      );
      if (!consumed.rows[0]) {
        return reply.code(400).send(apiError("invalid_grant", "Authorization code has already been used."));
      }
      return issueApplicationTokens(options.db, options.hostedProvider, authorizationCode.grant_id);
    }

    const refresh = await options.db.query<{
      id: string;
      grant_id: string;
      proof_public_key: string | null;
    }>(
      `SELECT rt.id, rt.grant_id, g.proof_public_key
       FROM refresh_tokens rt
       JOIN grants g ON g.id = rt.grant_id
       JOIN users u ON u.id = g.user_id
       WHERE rt.token_hash = $1 AND rt.used_at IS NULL AND rt.revoked_at IS NULL
         AND rt.expires_at > now() AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL AND g.application_id = $2
         AND u.suspended_at IS NULL`,
      [tokenHash(input.refresh_token), input.client_id]
    );
    const current = refresh.rows[0];
    if (!current) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token is invalid or expired."));
    }
    if (current.proof_public_key) {
      const refreshBody = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refresh_token,
        client_id: input.client_id
      }).toString();
      try {
        verifyAuthorityRequestProof(
          request.headers,
          current.proof_public_key,
          {
            method: "POST",
            target: "/oauth/token",
            body: refreshBody,
            credential: input.refresh_token
          }
        );
      } catch (error) {
        if (!(error instanceof AuthorityProofError)) throw error;
        return reply.code(400).send(oauthError(
          "invalid_grant",
          "The refresh request is not signed by the approved application key."
        ));
      }
    }
    const rotated = await options.db.query(
      `UPDATE refresh_tokens SET used_at = now()
       WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [current.id]
    );
    if (!rotated.rows[0]) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token has already been used."));
    }
    return issueApplicationTokens(options.db, options.hostedProvider, current.grant_id);
  });
}
