import type { ApplicationRequirements } from "@mdbase/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";

interface ConnectorControlRoutesOptions {
  db: DatabasePool;
}

export function registerConnectorControlRoutes(
  app: FastifyInstance,
  options: ConnectorControlRoutesOptions
): void {
  app.get("/v1/connectors/control", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const account = await options.db.query<{
      connector_id: string;
      connector_name: string;
      user_name: string;
      user_email: string;
    }>(
      `SELECT c.id AS connector_id, c.name AS connector_name,
              u.name AS user_name,
              COALESCE(i.email, '@' || i.login, u.email) AS user_email
       FROM connectors c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN external_identities i ON i.user_id = u.id
       WHERE c.id = $1`,
      [connector.id]
    );
    const grants = await options.db.query(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.distribution AS application_distribution,
              a.homepage AS application_homepage,
              a.project_url AS application_project_url,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              a.icon AS application_icon,
              col.local_id AS collection_id,
              col.display_name AS collection_name,
              g.operations, g.scope, g.encryption, g.created_at,
              g.notification_criteria
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE col.connector_id = $1 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL
       ORDER BY a.name, col.display_name`,
      [connector.id]
    );
    const pendingAuthorizations = await options.db.query<{
      requirements: ApplicationRequirements;
      [key: string]: unknown;
    }>(
      `SELECT ar.id, ar.application_id, a.name AS application_name,
              a.distribution AS application_distribution,
              a.homepage AS application_homepage,
              a.project_url AS application_project_url,
              a.icon AS application_icon, ar.flow, ar.user_code,
              ar.requested_operations,
              hinted.local_id AS collection_id, ar.expires_at,
              a.requirements, a.provisions, a.notifications
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       LEFT JOIN collections hinted
         ON hinted.local_id = ar.collection_id
        AND hinted.connector_id = $2
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL
         AND ar.denied_at IS NULL AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [connector.user_id, connector.id]
    );
    const authorityConflicts = await options.db.query(
      `SELECT candidate.local_id AS collection_id,
              candidate.display_name,
              COALESCE(
                active_connector.name,
                'mdbase cloud'
              ) AS active_connector_name
       FROM collections candidate
       LEFT JOIN collections active
         ON active.user_id = candidate.user_id
        AND active.local_id = candidate.local_id
        AND active.authority_state = 'active'
       LEFT JOIN connectors active_connector
         ON active_connector.id = active.connector_id
       WHERE candidate.connector_id = $1
         AND candidate.present = true
         AND candidate.authority_state = 'candidate'
       ORDER BY candidate.display_name`,
      [connector.id]
    );
    return {
      configured: true,
      online: true,
      account: account.rows[0],
      grants: grants.rows.map((grant) => ({
        ...grant,
        application_origin: normalizedApplicationOrigin(
          grant.application_origin
        )
      })),
      pending_authorizations: pendingAuthorizations.rows.filter(
        (authorization) =>
          authorization.requirements?.collection_kind !== "hosted"
      ),
      authority_conflicts: authorityConflicts.rows
    };
  });

  app.get("/v1/connectors/apps/:applicationId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { applicationId } = z.object({
      applicationId: z.uuid()
    }).parse(request.params);
    const application = await options.db.query(
      `SELECT id, distribution, name, homepage, project_url, icon,
              requirements, provisions, notifications
       FROM applications WHERE id = $1`,
      [applicationId]
    );
    if (!application.rows[0]) {
      return reply.code(404).send(apiError(
        "application_not_found",
        "Application not found."
      ));
    }
    return { application: application.rows[0] };
  });
}

function normalizedApplicationOrigin(value: string): string {
  return value === "null" ? "null" : new URL(value).origin;
}
