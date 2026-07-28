import type { DatabasePool } from "./db.js";
import {
  AuthenticationPolicyStore,
  type AuthenticationSettings
} from "./authentication-policy.js";
import { PasswordAccountService } from "./password-auth.js";
import type { RegistrationMode } from "./runtime-config.js";
import {
  EmailDeliveryError,
  type EmailTransport
} from "./email.js";
import { sendInvitationEmail } from "./invitation-email.js";

export interface AuthAdminContext {
  db: DatabasePool;
  defaultRegistrationMode: RegistrationMode;
  publicUrl?: string;
  emailTransport?: EmailTransport;
}

export async function runAuthAdminCommand(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const [area, action, ...rest] = argv;
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
  if (area === "invite" && action === "create") {
    return createInvitation(rest, context);
  }
  throw new AuthAdminUsageError(usage());
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

async function createInvitation(
  argv: string[],
  context: AuthAdminContext
): Promise<unknown> {
  const flags = parseFlags(argv, new Set([
    "email",
    "actor",
    "reason",
    "expires-in",
    "send-email"
  ]));
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
    ...(flags.has("expires-in")
      ? {
          expiresInSeconds: positiveInteger(
            requiredFlag(flags, "expires-in"),
            "expires-in"
          )
        }
      : {})
  });
  const invitationPath =
    `/signup#invitation=${encodeURIComponent(invitation.token)}`;
  const invitationOutput = {
    id: invitation.id,
    email: invitation.email,
    expires_at: invitation.expiresAt.toISOString(),
    terms_version: invitation.termsVersion,
    privacy_version: invitation.privacyVersion,
    token: invitation.token,
    invitation_path: invitationPath,
    ...(invitationOrigin
      ? { invitation_url: `${invitationOrigin}${invitationPath}` }
      : {})
  };
  const output = {
    invitation: {
      ...invitationOutput
    },
    delivery: { status: "not_requested" as const },
    sensitive: true,
    notice: "The invitation token is shown once. Send it only to the intended recipient."
  };
  if (!sendEmail) return output;
  const invitationUrl = "invitation_url" in invitationOutput
    ? invitationOutput.invitation_url
    : null;
  if (!invitationUrl) throw new Error("Invitation URL invariant failed.");
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
    "  auth-admin policy update --expected-revision <n> --actor <id> --reason <text> [changes]",
    "  auth-admin invite create --email <address> --actor <id> --reason <text> [--expires-in <seconds>] [--send-email enabled]",
    "",
    "Policy changes:",
    "  --registration closed|invite|open",
    "  --password-auth enabled|disabled",
    "  --email-delivery enabled|disabled",
    "  --terms-version <version|none>",
    "  --privacy-version <version|none>"
  ].join("\n");
}
