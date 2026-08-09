import type { FastifyInstance } from "fastify";
import { SyncError } from "@mdbase-dev/connect-sync";
import { ZodError } from "zod";
import {
  AccountDeletionAuthorizationError,
  ExternalIdentityConflictError,
  IdentityRemovalForbiddenError
} from "../account-management.js";
import { AccountUnavailableError } from "../external-auth.js";
import { HostedEntitlementRequiredError } from "../entitlements.js";
import { GitHubIdentityError } from "../github-auth.js";
import { GoogleIdentityError } from "../google-auth.js";
import {
  HostedProviderResponseError,
  HostedProviderUnavailableError
} from "../hosted-provider.js";
import { ApplicationManifestError } from "../manifest.js";
import {
  ApplicationAuthorizationError,
  ApplicationContractMismatchError
} from "../application-authorization.js";
import {
  AuthenticationPolicyIncompleteError,
  InvalidInvitationError,
  InvitationTargetConflictError,
  PasswordAuthenticationUnavailableError,
  PasswordCredentialUnavailableError,
  PasswordLoginRejectedError
} from "../password-auth.js";
import {
  InvalidPasswordResetError,
  PasswordRecoveryUnavailableError
} from "../password-recovery.js";
import { PasswordPolicyError } from "../password.js";
import { InvalidEmailAddressError } from "../email-identity.js";
import {
  ConnectorOperationError,
  RelayUnavailableError
} from "../relay.js";
import { CollectionAccessDeniedError } from "../collection-access.js";
import { GrantPlanningError } from "../grant-planner.js";
import {
  apiError,
  httpErrorStatus,
  OriginDeniedError,
  RequestValidationError
} from "./http-errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationManifestError) {
      return reply.code(400).send(apiError(
        "invalid_application_manifest",
        error.message,
        { issues: error.issues }
      ));
    }
    if (error instanceof ApplicationContractMismatchError) {
      return reply.code(409).send(apiError(error.code, error.message, error.details));
    }
    if (error instanceof ApplicationAuthorizationError) {
      return reply.code(400).send(apiError(
        "invalid_application_authorization",
        error.message
      ));
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(apiError(
        "invalid_request",
        error.issues[0]?.message ?? "Invalid request."
      ));
    }
    if (error instanceof RequestValidationError) {
      return reply.code(400).send(apiError("invalid_request", error.message));
    }
    if (error instanceof GrantPlanningError) {
      return reply.code(400).send(apiError("invalid_grant", error.message));
    }
    if (error instanceof CollectionAccessDeniedError) {
      return reply.code(403).send(apiError("collection_access_denied", error.message));
    }
    if (error instanceof OriginDeniedError) {
      return reply.code(403).send(apiError(
        "origin_denied",
        "The request origin is not allowed."
      ));
    }
    if (error instanceof RelayUnavailableError) {
      return reply.code(409).send(apiError("connector_offline", error.message));
    }
    if (error instanceof ConnectorOperationError) {
      if (error.code.startsWith("invalid_")) {
        request.log.warn(
          { metric: "boundary_response_failure", response_class: error.code },
          "privacy-safe Connect metric"
        );
      }
      return reply.code(409).send(apiError(error.code, error.message, error.details));
    }
    if (error instanceof SyncError) {
      const denied =
        error.code === "replica_revoked"
        || error.code === "scope_denied"
        || error.code === "read_only_replica";
      return reply.code(denied ? 403 : 400).send(apiError(error.code, error.message));
    }
    if (error instanceof HostedProviderResponseError) {
      if ([400, 404, 409, 422, 429].includes(error.status)) {
        return reply.code(error.status).send(apiError(error.code, error.message));
      }
      request.log.error(
        {
          metric: "boundary_response_failure",
          response_class: error.code,
          provider_status: error.status,
          provider_code: error.code
        },
        "Hosted provider rejected control request"
      );
      return reply.code(502).send(apiError(
        "hosted_provider_error",
        "The hosted storage provider could not complete the request."
      ));
    }
    if (error instanceof HostedProviderUnavailableError) {
      request.log.error({ error: error.cause }, "Hosted provider is unavailable");
      return reply.code(503).send(apiError("hosted_provider_unavailable", error.message));
    }
    if (error instanceof HostedEntitlementRequiredError) {
      return reply.code(403).send(apiError(
        "hosted_entitlement_required",
        error.message
      ));
    }
    if (error instanceof GitHubIdentityError) {
      request.log.warn({ error: error.message }, "GitHub authentication failed");
      return reply.code(502).send(apiError(
        "identity_provider_error",
        "GitHub sign-in could not be completed. Please try again."
      ));
    }
    if (error instanceof GoogleIdentityError) {
      request.log.warn({ error: error.message }, "Google authentication failed");
      return reply.code(502).send(apiError(
        "identity_provider_error",
        "Google sign-in could not be completed. Please try again."
      ));
    }
    if (error instanceof AccountUnavailableError) {
      return reply.code(403).send(apiError(
        "account_not_allowed",
        "This account does not have access."
      ));
    }
    if (error instanceof ExternalIdentityConflictError) {
      return reply.code(409).send(apiError(
        "identity_already_connected",
        error.message
      ));
    }
    if (error instanceof IdentityRemovalForbiddenError) {
      return reply.code(409).send(apiError(error.code, error.message));
    }
    if (error instanceof AccountDeletionAuthorizationError) {
      return reply.code(403).send(apiError(
        "account_reauthentication_required",
        error.message
      ));
    }
    if (error instanceof PasswordLoginRejectedError) {
      return reply.code(401).send(apiError(
        "invalid_credentials",
        "Email or password is incorrect."
      ));
    }
    if (error instanceof PasswordCredentialUnavailableError) {
      return reply.code(409).send(apiError(
        "password_not_configured",
        error.message
      ));
    }
    if (
      error instanceof InvalidInvitationError
      || error instanceof InvitationTargetConflictError
    ) {
      return reply.code(400).send(apiError(
        "invalid_invitation",
        "This invitation is invalid, expired, or can no longer be used."
      ));
    }
    if (error instanceof InvalidPasswordResetError) {
      return reply.code(400).send(apiError(
        "invalid_password_reset",
        "This password reset link is invalid, expired, or has already been used."
      ));
    }
    if (error instanceof PasswordPolicyError) {
      return reply.code(400).send(apiError("invalid_password", error.message));
    }
    if (error instanceof InvalidEmailAddressError) {
      return reply.code(400).send(apiError(
        "invalid_request",
        "Email address is invalid."
      ));
    }
    if (error instanceof PasswordAuthenticationUnavailableError) {
      return reply.code(503).send(apiError(
        "authentication_unavailable",
        "Password authentication is temporarily unavailable."
      ));
    }
    if (error instanceof PasswordRecoveryUnavailableError) {
      return reply.code(503).send(apiError(
        "password_recovery_unavailable",
        "Password recovery is temporarily unavailable."
      ));
    }
    if (error instanceof AuthenticationPolicyIncompleteError) {
      request.log.error("Password authentication policy is incomplete");
      return reply.code(503).send(apiError(
        "authentication_unavailable",
        "Password authentication is temporarily unavailable."
      ));
    }
    if (isDatabaseTimeoutError(error)) {
      request.log.warn({
        metric: "database_timeout",
        database_timeout_class: databaseTimeoutClass(error)
      }, "privacy-safe Connect metric");
      return reply.code(503).send(apiError(
        "database_timeout",
        "The service database is busy. Retry the request."
      ));
    }
    const statusCode = httpErrorStatus(error);
    if (statusCode === 413) {
      return reply.code(413).send(apiError(
        "payload_too_large",
        "The request body exceeds the allowed size."
      ));
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(apiError(
        "invalid_request",
        "The request body is invalid."
      ));
    }
    request.log.error(error);
    return reply.code(500).send(apiError(
      "internal_error",
      "The request could not be completed."
    ));
  });
}

export function isDatabaseTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "57014"
    || candidate.code === "55P03"
    || candidate.message === "timeout exceeded when trying to connect";
}

function databaseTimeoutClass(error: unknown): "lock" | "pool" | "statement" {
  const candidate = error as { code?: unknown };
  if (candidate.code === "55P03") return "lock";
  if (candidate.code === "57014") return "statement";
  return "pool";
}
