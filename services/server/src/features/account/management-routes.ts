import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accountSignInMethodCounts,
  removeExternalIdentity
} from "../../account-management.js";
import type { AuthenticationPolicyStore } from "../../authentication-policy.js";
import type { DatabasePool } from "../../database-types.js";
import type { HostedAuthorityRegistry } from "../../hosted.js";
import type {
  HostedCollectionUsage,
  HostedProviderClient
} from "../../hosted-provider.js";
import {
  PasswordAccountService,
  PasswordAuthenticationUnavailableError
} from "../../password-auth.js";
import { PASSWORD_MAX_UTF8_BYTES } from "../../password.js";
import { apiError } from "../../platform/http-errors.js";
import {
  requireSessionContext,
  requireUser
} from "../../platform/request-authentication.js";
import { requireSameOrigin } from "../../platform/request-security.js";

interface AccountManagementRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  managementOrigins?: string[];
  authenticationPolicy: AuthenticationPolicyStore;
  tailscaleAuth?: boolean;
  developmentAuth?: boolean;
  passwordAuthenticationAvailable?: boolean;
  githubAvailable?: boolean;
  googleAvailable?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReference?: HostedAuthorityRegistry;
}

interface ExternalIdentityRow {
  provider: "github" | "google";
  subject: string;
  login: string | null;
  email: string | null;
  email_verified: boolean;
  created_at: Date | string;
}

interface HostedCollectionRow {
  id: string;
  display_name: string;
}

export function registerAccountManagementRoutes(
  app: FastifyInstance,
  options: AccountManagementRoutesOptions
): void {
  const passwordAccounts = new PasswordAccountService(
    options.db,
    options.authenticationPolicy
  );

  app.get("/v1/account", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const [identities, methods, passwordEmail, hostedCollections, counts, settings] =
      await Promise.all([
        options.db.query<ExternalIdentityRow>(
          `SELECT provider, subject, login, email, email_verified, created_at
           FROM external_identities
           WHERE user_id = $1
           ORDER BY provider`,
          [user.id]
        ),
        accountSignInMethodCounts(options.db, user.id),
        options.db.query<{ email: string }>(
          `SELECT e.email FROM email_identities e
           JOIN password_credentials p ON p.user_id = e.user_id
           WHERE e.user_id = $1 AND e.is_primary = true
             AND e.retired_at IS NULL`,
          [user.id]
        ),
        options.db.query<HostedCollectionRow>(
          `SELECT id, display_name FROM hosted_collections
           WHERE user_id = $1 AND authority_state <> 'transferred'
           ORDER BY display_name`,
          [user.id]
        ),
        options.db.query<{
          connectors: string | number;
          local_collections: string | number;
        }>(
          `SELECT
             (SELECT count(*) FROM connectors WHERE user_id = $1 AND revoked_at IS NULL) AS connectors,
             (SELECT count(*) FROM collections WHERE user_id = $1 AND present = true) AS local_collections`,
          [user.id]
        ),
        options.authenticationPolicy.current()
      ]);
    const storage = await storageSnapshot(
      hostedCollections.rows,
      options.hostedProvider,
      request.log
    );
    const authenticationProvider = user.authentication_provider ?? (
      options.tailscaleAuth ? "tailscale" : "session"
    );
    const methodCount = methods.external + Number(methods.password);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        login: user.login
      },
      authentication: {
        managed: authenticationProvider !== "tailscale",
        current_provider: authenticationProvider,
        available_providers: {
          github: options.githubAvailable === true,
          google: options.googleAvailable === true,
          password: settings.passwordAuthEnabled
            && options.passwordAuthenticationAvailable === true
        },
        identities: identities.rows.map((identity) => ({
          provider: identity.provider,
          subject: identity.subject,
          login: identity.login,
          email: identity.email,
          email_verified: identity.email_verified,
          linked_at: new Date(identity.created_at).toISOString(),
          current: authenticationProvider === identity.provider,
          removable: authenticationProvider !== identity.provider && methodCount > 1
        })),
        password: {
          configured: methods.password,
          email: passwordEmail.rows[0]?.email ?? null,
          current: authenticationProvider === "password",
          change_available: methods.password
            && settings.passwordAuthEnabled
            && options.passwordAuthenticationAvailable === true
        }
      },
      storage,
      deletion: {
        available: false,
        unavailable_reason: "temporarily_disabled",
        hosted_collections: hostedCollections.rows.length,
        local_collections: Number(counts.rows[0]?.local_collections ?? 0),
        computers: Number(counts.rows[0]?.connectors ?? 0),
        development_confirmation: false
      }
    };
  });

  app.patch("/v1/account/password", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(request, reply, options.db);
    if (!authenticated) return;
    const settings = await options.authenticationPolicy.current();
    if (
      !settings.passwordAuthEnabled
      || options.passwordAuthenticationAvailable !== true
    ) {
      throw new PasswordAuthenticationUnavailableError();
    }
    const input = z.object({
      current_password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES),
      new_password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES)
    }).strict().parse(request.body);
    await passwordAccounts.changePassword({
      userId: authenticated.user.id,
      sessionId: authenticated.sessionId,
      currentPassword: input.current_password,
      newPassword: input.new_password
    });
    return { ok: true, other_sessions_signed_out: true };
  });

  app.delete("/v1/account/identities/:provider", async (request, reply) => {
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(request, reply, options.db);
    if (!authenticated) return;
    const { provider } = z.object({
      provider: z.enum(["github", "google"])
    }).parse(request.params);
    const removed = await removeExternalIdentity(
      options.db,
      authenticated.user.id,
      provider,
      authenticated.user.authentication_provider
    );
    if (!removed) {
      return reply.code(404).send(apiError(
        "identity_not_found",
        "That sign-in method is no longer connected."
      ));
    }
    return { ok: true };
  });

  app.delete("/v1/account", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(request, reply, options.db);
    if (!authenticated) return;
    return reply.code(503).send(apiError(
      "account_deletion_unavailable",
      "Account deletion is temporarily unavailable."
    ));
  });
}

async function storageSnapshot(
  collections: HostedCollectionRow[],
  provider: HostedProviderClient | undefined,
  log: { warn(value: unknown, message: string): void }
) {
  if (collections.length === 0) {
    return {
      status: "available" as const,
      total_content_bytes: 0,
      total_file_bytes: 0,
      total_storage_bytes: 0,
      total_stored_file_bytes: 0,
      total_records: 0,
      collections: []
    };
  }
  if (!provider) {
    return {
      status: "unavailable" as const,
      total_content_bytes: null,
      total_file_bytes: null,
      total_storage_bytes: null,
      total_stored_file_bytes: null,
      total_records: null,
      collections: collections.map((collection) => ({
        ...collection,
        usage: null
      }))
    };
  }
  const usage = await Promise.all(collections.map(async (collection) => {
    try {
      return await provider.collectionUsage(collection.id);
    } catch (error) {
      log.warn(
        { error, collection_id: collection.id },
        "Hosted storage usage is unavailable"
      );
      return null;
    }
  }));
  const available = usage.filter(
    (value): value is HostedCollectionUsage => value !== null
  );
  return {
    status: available.length === collections.length
      ? "available" as const
      : available.length > 0
        ? "partial" as const
        : "unavailable" as const,
    total_content_bytes: available.length > 0
      ? available.reduce((total, value) => total + value.content_bytes, 0)
      : null,
    total_file_bytes: available.length > 0
      ? available.reduce((total, value) => total + value.file_bytes, 0)
      : null,
    total_storage_bytes: available.length > 0
      ? available.reduce(
          (total, value) => total + value.content_bytes + value.file_bytes,
          0
        )
      : null,
    total_stored_file_bytes: available.length > 0
      ? available.reduce((total, value) => total + value.stored_file_bytes, 0)
      : null,
    total_records: available.length > 0
      ? available.reduce((total, value) => total + value.record_count, 0)
      : null,
    collections: collections.map((collection, index) => ({
      ...collection,
      usage: usage[index]
    }))
  };
}
