import { randomUUID } from "node:crypto";
import type { DatabasePool } from "./db.js";
import {
  AuthenticationPolicyStore,
  type AuthenticationSettings
} from "./authentication-policy.js";
import { PasswordAccountService } from "./password-auth.js";
import { normalizeEmailAddress } from "./email-identity.js";
import type { RegistrationMode } from "./runtime-config.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import {
  effectiveEntitlement,
  grantOperatorEntitlement,
  reconcileHostedAccountCollections
} from "./entitlements.js";
import {
  EmailDeliveryError,
  type EmailTransport
} from "./email.js";
import { sendInvitationEmail } from "./invitation-email.js";
import {
  InstanceAdminService,
  type HostedReplicaRevoker,
  type OperatorMutation
} from "./instance-admin.js";

export interface AuthAdminContext {
  db: DatabasePool;
  defaultRegistrationMode: RegistrationMode;
  publicUrl?: string;
  emailTransport?: EmailTransport;
  hostedReplicaRevoker?: HostedReplicaRevoker;
  hostedProvider?: HostedProviderClient;
}

export async function runAuthAdminCommand(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  return runCommand(argv, context, true);
}

async function runCommand(
  argv: string[],
  context: AuthAdminContext,
  allowRequestEnvelope: boolean
): Promise<unknown> {
  const [area, action, ...rest] = argv;
  if (area === "request" && action && allowRequestEnvelope) {
    requireNoArguments(rest);
    return runCommand(decodeRequestEnvelope(action), context, false);
  }
  if (area === "policy" && action === "show") {
    requireNoArguments(rest);
    return {
      policy: await new AuthenticationPolicyStore(
        context.db,
        context.defaultRegistrationMode
      ).current()
    };
  }
  if (area === "policy" && action === "update") {
    return updatePolicy(rest, context);
  }
  if (area === "policy" && action === "history") {
    return policyHistory(rest, context);
  }
  if (area === "invite" && action === "create") {
    return createInvitation(rest, context);
  }
  if (area === "invite" && action === "list") {
    return listInvitations(rest, context);
  }
  if (area === "invite" && action === "show") {
    return showInvitation(rest, context);
  }
  if (area === "invite" && action === "revoke") {
    return revokeInvitation(rest, context);
  }
  if (area === "invite" && action === "resend") {
    return resendInvitation(rest, context);
  }
  if (area === "beta" && action === "list") {
    return listBetaAccessRequests(rest, context);
  }
  if (area === "entitlements" && action === "show") {
    return showEntitlements(rest, context);
  }
  if (area === "entitlements" && action === "grant") {
    return grantEntitlements(rest, context);
  }
  if (area === "entitlements" && action === "reconcile") {
    return reconcileEntitlements(rest, context);
  }
  if (area === "users" && action === "list") {
    return listUsers(rest, context);
  }
  if (area === "users" && action === "show") {
    return showUser(rest, context);
  }
  if (area === "users" && action === "suspend") {
    return suspendUser(rest, context);
  }
  if (area === "users" && action === "restore") {
    return restoreUser(rest, context);
  }
  if (area === "users" && action === "revoke-sessions") {
    return revokeUserSessions(rest, context);
  }
  if (area === "audit" && action === "list") {
    return listAudit(rest, context);
  }
  throw new AuthAdminUsageError(usage());
}

async function showEntitlements(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["user"]));
  const found = await instanceAdmin(context).showUser(requiredFlag(flags, "user"));
  const userId = found.user.id;
  const entitlement = await effectiveEntitlement(context.db, userId);
  const storage = await context.db.query(
    `SELECT provider_account_id, entitlement_revision, provider_revision,
            created_at, updated_at
     FROM account_storage_accounts WHERE user_id = $1`,
    [userId]
  );
  const grants = await context.db.query(
    `SELECT profile_code, source, source_reference, starts_at, ends_at,
            revoked_at, created_at
     FROM account_entitlement_grants WHERE user_id = $1
     ORDER BY created_at, id`,
    [userId]
  );
  const providerUsage = context.hostedProvider && storage.rows[0]
    ? await context.hostedProvider.accountUsage(storage.rows[0].provider_account_id)
    : null;
  return {
    user: { id: userId, email: found.user.email, name: found.user.name },
    effective: entitlement,
    storage_account: storage.rows[0] ?? null,
    provider_usage: providerUsage,
    grants: grants.rows
  };
}

async function grantEntitlements(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set([
    "user", "profile", "operation-id", "actor", "reason"
  ]));
  const found = await instanceAdmin(context).showUser(requiredFlag(flags, "user"));
  const result = await grantOperatorEntitlement(context.db, {
    userId: found.user.id,
    profileCode: entitlementProfile(requiredFlag(flags, "profile")),
    operationId: requiredFlag(flags, "operation-id"),
    actor: requiredFlag(flags, "actor"),
    reason: requiredFlag(flags, "reason")
  });
  const reconciliation = context.hostedProvider
    ? await reconcileHostedAccountCollections(
        context.db,
        context.hostedProvider,
        found.user.id
      )
    : null;
  return {
    user_id: found.user.id,
    ...result,
    reconciliation
  };
}

async function reconcileEntitlements(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  if (!context.hostedProvider) {
    throw new AuthAdminUsageError(
      "Entitlement reconciliation requires a configured hosted provider."
    );
  }
  const flags = parseFlags(argv, new Set([
    "user", "all", "operation-id", "actor", "reason"
  ]));
  const operationId = requiredFlag(flags, "operation-id");
  const actor = requiredFlag(flags, "actor");
  const reason = requiredFlag(flags, "reason");
  const all = flags.has("all")
    && enabledFlag(requiredFlag(flags, "all"), "all");
  if (all === flags.has("user")) {
    throw new AuthAdminUsageError(
      "Entitlement reconciliation requires exactly one of --user or --all enabled."
    );
  }
  const userIds = all
    ? (await context.db.query<{ id: string }>(
        "SELECT id FROM users WHERE suspended_at IS NULL ORDER BY id"
      )).rows.map((row) => row.id)
    : [
        (await instanceAdmin(context).showUser(
          requiredFlag(flags, "user")
        )).user.id
      ];
  const reconciled = [];
  for (const userId of userIds) {
    const result = await reconcileHostedAccountCollections(
      context.db,
      context.hostedProvider,
      userId
    );
    reconciled.push({
      user_id: userId,
      provider_account_id: result.providerAccountId,
      entitlement_revision: result.entitlementRevision,
      reconciled_collections: result.reconciledCollections,
      usage: result.usage
    });
    await context.db.query(
      `INSERT INTO audit_events
         (id, user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'entitlement.reconciled', $2, $3::jsonb)`,
      [
        randomUUID(),
        userId,
        JSON.stringify({
          actor,
          reason,
          operation_id: operationId,
          entitlement_revision: result.entitlementRevision,
          reconciled_collections: result.reconciledCollections
        })
      ]
    );
  }
  return { operation_id: operationId, reconciled };
}

export class AuthAdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthAdminUsageError";
  }
}

export class InvitationDeliveryError extends Error {
  constructor(public readonly output: unknown) {
    super("The invitation was created, but delivery did not complete cleanly.");
    this.name = "InvitationDeliveryError";
  }
}

async function updatePolicy(
  argv: string[],
  context: AuthAdminContext
): Promise<{ policy: AuthenticationSettings }> {
  const flags = parseFlags(argv, new Set([
    "expected-revision",
    "registration",
    "password-auth",
    "email-delivery",
    "terms-version",
    "privacy-version",
    "actor",
    "reason"
  ]));
  if (![...flags.keys()].some((name) => [
    "registration",
    "password-auth",
    "email-delivery",
    "terms-version",
    "privacy-version"
  ].includes(name))) {
    throw new AuthAdminUsageError(
      "Policy update requires at least one setting change."
    );
  }
  const policy = new AuthenticationPolicyStore(
    context.db,
    context.defaultRegistrationMode
  );
  const current = await policy.current();
  const updated = await policy.update({
    registrationMode: flags.has("registration")
      ? registrationMode(requiredFlag(flags, "registration"))
      : current.registrationMode,
    passwordAuthEnabled: flags.has("password-auth")
      ? enabledFlag(requiredFlag(flags, "password-auth"), "password-auth")
      : current.passwordAuthEnabled,
    emailDeliveryEnabled: flags.has("email-delivery")
      ? enabledFlag(requiredFlag(flags, "email-delivery"), "email-delivery")
      : current.emailDeliveryEnabled,
    termsVersion: flags.has("terms-version")
      ? nullableVersion(requiredFlag(flags, "terms-version"))
      : current.termsVersion,
    privacyVersion: flags.has("privacy-version")
      ? nullableVersion(requiredFlag(flags, "privacy-version"))
      : current.privacyVersion,
    expectedRevision: nonNegativeInteger(
      requiredFlag(flags, "expected-revision"),
      "expected-revision"
    ),
    updatedBy: requiredFlag(flags, "actor"),
    reason: requiredFlag(flags, "reason")
  });
  return { policy: updated };
}

async function policyHistory(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["limit", "before-revision"]));
  const limit = pageLimit(flags);
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (flags.has("before-revision")) {
    values.push(nonNegativeInteger(
      requiredFlag(flags, "before-revision"),
      "before-revision"
    ));
    conditions.push(`revision < $${values.length}`);
  }
  values.push(limit + 1);
  const result = await context.db.query<{
    revision: string | number;
    registration_mode: RegistrationMode;
    password_auth_enabled: boolean;
    email_delivery_enabled: boolean;
    terms_version: string | null;
    privacy_version: string | null;
    updated_by: string;
    update_reason: string;
    updated_at: Date | string;
  }>(
    `SELECT revision, registration_mode, password_auth_enabled,
            email_delivery_enabled, terms_version, privacy_version,
            updated_by, update_reason, updated_at
     FROM authentication_settings_history
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY revision DESC
     LIMIT $${values.length}`,
    values
  );
  const rows = result.rows.slice(0, limit);
  return {
    revisions: rows.map((row) => ({
      revision: Number(row.revision),
      registration_mode: row.registration_mode,
      password_auth_enabled: row.password_auth_enabled,
      email_delivery_enabled: row.email_delivery_enabled,
      terms_version: row.terms_version,
      privacy_version: row.privacy_version,
      updated_by: row.updated_by,
      update_reason: row.update_reason,
      updated_at: new Date(row.updated_at).toISOString()
    })),
    next_before_revision: result.rows.length > limit && rows.length
      ? Number(rows[rows.length - 1]!.revision)
      : null
  };
}

async function createInvitation(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set([
    "email",
    "actor",
    "reason",
    "expires-in",
    "entitlement-profile",
    "send-email",
    "token-output"
  ]));
  return createAndDeliverInvitation(flags, context);
}

async function createAndDeliverInvitation(
  flags: Map<string, string>,
  context: AuthAdminContext
): Promise<unknown> {
  const policy = new AuthenticationPolicyStore(
    context.db,
    context.defaultRegistrationMode
  );
  const sendEmail = flags.has("send-email")
    && enabledFlag(requiredFlag(flags, "send-email"), "send-email");
  if (sendEmail && !context.emailTransport) {
    throw new AuthAdminUsageError(
      "Email delivery requires MDBASE_CONNECT_RESEND_API_KEY and MDBASE_CONNECT_EMAIL_FROM."
    );
  }
  if (sendEmail && !(await policy.current()).emailDeliveryEnabled) {
    throw new AuthAdminUsageError(
      "Email delivery is disabled by the current authentication policy."
    );
  }
  const invitationOrigin = context.publicUrl
    ? publicOrigin(context.publicUrl)
    : null;
  if (sendEmail && !invitationOrigin) {
    throw new AuthAdminUsageError(
      "Email delivery requires PUBLIC_URL to generate the invitation link."
    );
  }
  const passwordAccounts = new PasswordAccountService(
    context.db,
    policy
  );
  const invitation = await passwordAccounts.createInvitation({
    email: requiredFlag(flags, "email"),
    actor: requiredFlag(flags, "actor"),
    reason: requiredFlag(flags, "reason"),
    ...(flags.has("entitlement-profile")
      ? {
          entitlementProfile: entitlementProfile(
            requiredFlag(flags, "entitlement-profile")
          )
        }
      : {}),
    ...(flags.has("expires-in")
      ? {
          expiresInSeconds: positiveInteger(
            requiredFlag(flags, "expires-in"),
            "expires-in"
          )
        }
      : {})
  });
  await context.db.query(
    `UPDATE beta_access_requests
     SET invitation_id = $2, invited_at = now()
     WHERE normalized_email = $1`,
    [normalizeEmailAddress(invitation.email), invitation.id]
  );
  const invitationPath =
    `/signup#invitation=${encodeURIComponent(invitation.token)}`;
  const showToken = !flags.has("token-output")
    || tokenOutput(requiredFlag(flags, "token-output")) === "shown";
  const invitationOutput = {
    id: invitation.id,
    email: invitation.email,
    expires_at: invitation.expiresAt.toISOString(),
    terms_version: invitation.termsVersion,
    privacy_version: invitation.privacyVersion,
    entitlement_profile: invitation.entitlementProfile,
    ...(showToken
      ? {
          token: invitation.token,
          invitation_path: invitationPath
        }
      : {}),
    ...(showToken && invitationOrigin
      ? { invitation_url: `${invitationOrigin}${invitationPath}` }
      : {})
  };
  const output = {
    invitation: {
      ...invitationOutput
    },
    delivery: { status: "not_requested" as const },
    sensitive: showToken,
    notice: showToken
      ? "The invitation token is shown once. Send it only to the intended recipient."
      : "The invitation token was omitted from operator output."
  };
  if (!sendEmail) return output;
  const invitationUrl = `${invitationOrigin}${invitationPath}`;
  let delivery: Awaited<ReturnType<typeof sendInvitationEmail>>;
  try {
    delivery = await sendInvitationEmail(context.emailTransport!, {
      invitationId: invitation.id,
      to: invitation.email,
      invitationUrl,
      expiresAt: invitation.expiresAt
    });
  } catch (error) {
    const failure = {
      status: "failed" as const,
      code: error instanceof EmailDeliveryError
        ? error.code
        : "email_delivery_failed",
      retryable: error instanceof EmailDeliveryError
        ? error.retryable
        : false
    };
    await passwordAccounts.recordInvitationDelivery(invitation.id, {
      ...failure,
      provider: "transactional_email"
    }).catch(() => {});
    throw new InvitationDeliveryError({
      ...output,
      delivery: failure
    });
  }
  try {
    await passwordAccounts.recordInvitationDelivery(invitation.id, {
      status: "sent",
      provider: delivery.provider,
      messageId: delivery.messageId
    });
  } catch {
    throw new InvitationDeliveryError({
      ...output,
      delivery: {
        status: "sent_unrecorded",
        provider: delivery.provider,
        message_id: delivery.messageId,
        retryable: false
      }
    });
  }
  return {
    ...output,
    delivery: {
      status: "sent",
      provider: delivery.provider,
      message_id: delivery.messageId
    }
  };
}

async function listInvitations(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["limit", "cursor", "status"]));
  return instanceAdmin(context).listInvitations({
    limit: pageLimit(flags),
    ...(flags.has("cursor")
      ? { cursor: requiredFlag(flags, "cursor") }
      : {}),
    ...(flags.has("status")
      ? { status: invitationStatus(requiredFlag(flags, "status")) }
      : {})
  });
}

async function listBetaAccessRequests(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["limit", "cursor", "status"]));
  return instanceAdmin(context).listBetaAccessRequests({
    limit: pageLimit(flags),
    ...(flags.has("cursor")
      ? { cursor: requiredFlag(flags, "cursor") }
      : {}),
    ...(flags.has("status")
      ? { status: betaAccessStatus(requiredFlag(flags, "status")) }
      : {})
  });
}

async function showInvitation(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["id"]));
  return instanceAdmin(context).showInvitation(requiredFlag(flags, "id"));
}

async function revokeInvitation(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(
    argv,
    new Set(["id", "operation-id", "actor", "reason"])
  );
  return instanceAdmin(context).revokeInvitation(
    requiredFlag(flags, "id"),
    mutationFlags(flags)
  );
}

async function resendInvitation(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(
    argv,
    new Set(["id", "actor", "reason", "expires-in"])
  );
  const invitationId = requiredFlag(flags, "id");
  const existing = await instanceAdmin(context).showInvitation(invitationId) as {
    invitation: {
      email: string;
      status: string;
      entitlement_profile: string | null;
    };
  };
  if (existing.invitation.status === "accepted") {
    throw new AuthAdminUsageError(
      "An accepted invitation cannot be resent."
    );
  }
  const createFlags = new Map<string, string>([
    ["email", existing.invitation.email],
    ["actor", requiredFlag(flags, "actor")],
    ["reason", requiredFlag(flags, "reason")],
    ["send-email", "enabled"],
    ["token-output", "omitted"]
  ]);
  if (flags.has("expires-in")) {
    createFlags.set("expires-in", requiredFlag(flags, "expires-in"));
  }
  if (existing.invitation.entitlement_profile) {
    createFlags.set(
      "entitlement-profile",
      existing.invitation.entitlement_profile
    );
  }
  const result = await createAndDeliverInvitation(createFlags, context) as {
    invitation: Record<string, unknown>;
  };
  return {
    ...result,
    invitation: {
      ...result.invitation,
      replaces_invitation_id: invitationId
    }
  };
}

async function listUsers(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["limit", "cursor", "status"]));
  return instanceAdmin(context).listUsers({
    limit: pageLimit(flags),
    ...(flags.has("cursor")
      ? { cursor: requiredFlag(flags, "cursor") }
      : {}),
    ...(flags.has("status")
      ? { status: userStatus(requiredFlag(flags, "status")) }
      : {})
  });
}

async function showUser(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set(["user"]));
  return instanceAdmin(context).showUser(requiredFlag(flags, "user"));
}

async function suspendUser(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(
    argv,
    new Set(["user", "operation-id", "actor", "reason"])
  );
  return instanceAdmin(context).suspendUser(
    requiredFlag(flags, "user"),
    mutationFlags(flags)
  );
}

async function restoreUser(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(
    argv,
    new Set(["user", "operation-id", "actor", "reason"])
  );
  return instanceAdmin(context).restoreUser(
    requiredFlag(flags, "user"),
    mutationFlags(flags)
  );
}

async function revokeUserSessions(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(
    argv,
    new Set(["user", "operation-id", "actor", "reason"])
  );
  return instanceAdmin(context).revokeUserSessions(
    requiredFlag(flags, "user"),
    mutationFlags(flags)
  );
}

async function listAudit(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(
    argv,
    new Set(["limit", "cursor", "user-id", "event-type"])
  );
  return instanceAdmin(context).listAuditEvents({
    limit: pageLimit(flags),
    ...(flags.has("cursor")
      ? { cursor: requiredFlag(flags, "cursor") }
      : {}),
    ...(flags.has("user-id")
      ? { userId: requiredFlag(flags, "user-id") }
      : {}),
    ...(flags.has("event-type")
      ? { eventType: requiredFlag(flags, "event-type") }
      : {})
  });
}

function instanceAdmin(context: AuthAdminContext): InstanceAdminService {
  return new InstanceAdminService(context.db, context.hostedReplicaRevoker);
}

function mutationFlags(flags: Map<string, string>): OperatorMutation {
  return {
    operationId: requiredFlag(flags, "operation-id"),
    actor: requiredFlag(flags, "actor"),
    reason: requiredFlag(flags, "reason")
  };
}

function parseFlags(
  argv: string[],
  allowed: ReadonlySet<string>
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index] ?? "";
    const value = argv[index + 1];
    if (!option.startsWith("--") || !value || value.startsWith("--")) {
      throw new AuthAdminUsageError(`Expected a value after ${option || "option"}.`);
    }
    const name = option.slice(2);
    if (!allowed.has(name)) {
      throw new AuthAdminUsageError(`Unknown option: --${name}.`);
    }
    if (flags.has(name)) {
      throw new AuthAdminUsageError(`Option --${name} may be supplied only once.`);
    }
    flags.set(name, value);
  }
  return flags;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new AuthAdminUsageError(`Missing required option: --${name}.`);
  return value;
}

function registrationMode(value: string): RegistrationMode {
  if (value !== "closed" && value !== "invite" && value !== "open") {
    throw new AuthAdminUsageError(
      "--registration must be closed, invite, or open."
    );
  }
  return value;
}

function enabledFlag(value: string, name: string): boolean {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  throw new AuthAdminUsageError(`--${name} must be enabled or disabled.`);
}

function nullableVersion(value: string): string | null {
  return value === "none" ? null : value;
}

function nonNegativeInteger(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AuthAdminUsageError(`--${name} must be a non-negative integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new AuthAdminUsageError(`--${name} is too large.`);
  }
  return number;
}

function positiveInteger(value: string, name: string): number {
  const number = nonNegativeInteger(value, name);
  if (number === 0) {
    throw new AuthAdminUsageError(`--${name} must be greater than zero.`);
  }
  return number;
}

function pageLimit(flags: Map<string, string>): number {
  if (!flags.has("limit")) return 25;
  const limit = positiveInteger(requiredFlag(flags, "limit"), "limit");
  if (limit > 100) {
    throw new AuthAdminUsageError("--limit must not exceed 100.");
  }
  return limit;
}

function tokenOutput(value: string): "shown" | "omitted" {
  if (value === "shown" || value === "omitted") return value;
  throw new AuthAdminUsageError(
    "--token-output must be shown or omitted."
  );
}

function entitlementProfile(value: string): string {
  if (/^[a-z][a-z0-9_]{0,99}$/u.test(value)) return value;
  throw new AuthAdminUsageError("Entitlement profile is invalid.");
}

function invitationStatus(
  value: string
): "active" | "accepted" | "revoked" | "expired" {
  if (
    value === "active"
    || value === "accepted"
    || value === "revoked"
    || value === "expired"
  ) {
    return value;
  }
  throw new AuthAdminUsageError(
    "--status must be active, accepted, revoked, or expired."
  );
}

function betaAccessStatus(value: string): "pending" | "invited" {
  if (value === "pending" || value === "invited") return value;
  throw new AuthAdminUsageError(
    "--status must be pending or invited."
  );
}

function userStatus(value: string): "active" | "suspended" {
  if (value === "active" || value === "suspended") return value;
  throw new AuthAdminUsageError(
    "--status must be active or suspended."
  );
}

function decodeRequestEnvelope(value: string): string[] {
  if (value.length > 32_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AuthAdminUsageError("Operator request envelope is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new AuthAdminUsageError("Operator request envelope is invalid.");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 2
    || parsed.length > 100
    || parsed.some((item) =>
      typeof item !== "string"
      || item.length === 0
      || item.length > 2_000
    )
    || parsed[0] === "request"
  ) {
    throw new AuthAdminUsageError("Operator request envelope is invalid.");
  }
  return parsed as string[];
}

function publicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthAdminUsageError(
      "PUBLIC_URL must be an absolute origin before an invitation URL can be generated."
    );
  }
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new AuthAdminUsageError(
      "PUBLIC_URL must be an origin before an invitation URL can be generated."
    );
  }
  if (
    url.protocol !== "https:"
    && !(
      url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    )
  ) {
    throw new AuthAdminUsageError(
      "PUBLIC_URL must use HTTPS outside loopback development."
    );
  }
  return url.origin;
}

function requireNoArguments(argv: string[]): void {
  if (argv.length > 0) throw new AuthAdminUsageError(usage());
}

export function usage(): string {
  return [
    "Usage:",
    "  auth-admin policy show",
    "  auth-admin policy history [--limit <n>] [--before-revision <n>]",
    "  auth-admin policy update --expected-revision <n> --actor <id> --reason <text> [changes]",
    "  auth-admin invite create --email <address> --actor <id> --reason <text> [--entitlement-profile <code>] [--expires-in <seconds>] [--send-email enabled] [--token-output shown|omitted]",
    "  auth-admin invite list [--status <status>] [--limit <n>] [--cursor <cursor>]",
    "  auth-admin invite show --id <uuid>",
    "  auth-admin invite revoke --id <uuid> --operation-id <uuid> --actor <id> --reason <text>",
    "  auth-admin invite resend --id <uuid> --actor <id> --reason <text> [--expires-in <seconds>]",
    "  auth-admin beta list [--status pending|invited] [--limit <n>] [--cursor <cursor>]",
    "  auth-admin entitlements show --user <uuid|email>",
    "  auth-admin entitlements grant --user <uuid|email> --profile <code> --operation-id <uuid> --actor <id> --reason <text>",
    "  auth-admin entitlements reconcile (--user <uuid|email> | --all enabled) --operation-id <uuid> --actor <id> --reason <text>",
    "  auth-admin users list [--status active|suspended] [--limit <n>] [--cursor <cursor>]",
    "  auth-admin users show --user <uuid|email>",
    "  auth-admin users suspend --user <uuid|email> --operation-id <uuid> --actor <id> --reason <text>",
    "  auth-admin users restore --user <uuid|email> --operation-id <uuid> --actor <id> --reason <text>",
    "  auth-admin users revoke-sessions --user <uuid|email> --operation-id <uuid> --actor <id> --reason <text>",
    "  auth-admin audit list [--user-id <uuid>] [--event-type <type>] [--limit <n>] [--cursor <cursor>]",
    "  auth-admin request <base64url-json-argv>",
    "",
    "Policy changes:",
    "  --registration closed|invite|open",
    "  --password-auth enabled|disabled",
    "  --email-delivery enabled|disabled",
    "  --terms-version <version|none>",
    "  --privacy-version <version|none>"
  ].join("\n");
}
