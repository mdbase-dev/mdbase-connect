import type {
  FastifyInstance,
  FastifyReply
} from "fastify";
import { z } from "zod";
import {
  AuthRateLimiter,
  type AuthRateLimitRule
} from "../../auth-rate-limit.js";
import { sessionClientName } from "../../account-sessions.js";
import type { AuthenticationPolicyStore } from "../../authentication-policy.js";
import type { DatabasePool } from "../../database-types.js";
import {
  EmailDeliveryError,
  type EmailTransport
} from "../../email.js";
import { normalizeEmailAddress } from "../../email-identity.js";
import {
  AuthenticationPolicyIncompleteError,
  PasswordAccountService,
  PasswordAuthenticationUnavailableError
} from "../../password-auth.js";
import {
  PasswordRecoveryService,
  PasswordRecoveryUnavailableError
} from "../../password-recovery.js";
import { sendPasswordResetEmail } from "../../password-reset-email.js";
import { PASSWORD_MAX_UTF8_BYTES } from "../../password.js";
import type { AuthenticationLegalDocuments } from "../../runtime-config.js";
import { apiError } from "../../platform/http-errors.js";
import { requireSameOrigin } from "../../platform/request-security.js";
import { setSessionCookie } from "../../platform/session-cookies.js";

const PASSWORD_LOGIN_EMAIL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 5,
  windowSeconds: 15 * 60,
  baseBlockSeconds: 5 * 60,
  maxBlockSeconds: 60 * 60
};
const PASSWORD_LOGIN_IP_LIMIT: AuthRateLimitRule = {
  maxAttempts: 30,
  windowSeconds: 15 * 60,
  baseBlockSeconds: 5 * 60,
  maxBlockSeconds: 60 * 60
};
const PASSWORD_SIGNUP_TOKEN_LIMIT: AuthRateLimitRule = {
  maxAttempts: 5,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_SIGNUP_IP_LIMIT: AuthRateLimitRule = {
  maxAttempts: 10,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_RECOVERY_EMAIL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 3,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_RECOVERY_IP_LIMIT: AuthRateLimitRule = {
  maxAttempts: 10,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_RESET_TOKEN_LIMIT: AuthRateLimitRule = {
  maxAttempts: 5,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_AUTH_GLOBAL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 300,
  windowSeconds: 60,
  baseBlockSeconds: 60,
  maxBlockSeconds: 15 * 60
};

interface PasswordAuthRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  authenticationPolicy: AuthenticationPolicyStore;
  authRateLimitSecret?: string;
  authenticationLegalDocuments?: AuthenticationLegalDocuments;
  emailTransport?: EmailTransport;
  providers: {
    development: boolean;
    tailscale: boolean;
    github: boolean;
    google: boolean;
  };
}

interface AuthenticationLimitAttempt {
  scope: string;
  key: string;
  rule: AuthRateLimitRule;
}

export function registerPasswordAuthRoutes(
  app: FastifyInstance,
  options: PasswordAuthRoutesOptions
): void {
  const passwordAccounts = new PasswordAccountService(
    options.db,
    options.authenticationPolicy
  );
  const passwordRecovery = new PasswordRecoveryService(
    options.db,
    options.authenticationPolicy
  );
  const authenticationRateLimiter = options.authRateLimitSecret
    ? new AuthRateLimiter(options.db, options.authRateLimitSecret)
    : null;

  app.get("/v1/auth/config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const authenticationSettings = await options.authenticationPolicy.current();
    const passwordLogin =
      authenticationSettings.passwordAuthEnabled
      && authenticationRateLimiter !== null;
    const passwordRegistration =
      passwordLogin
      && authenticationSettings.registrationMode === "invite"
      && Boolean(authenticationSettings.termsVersion)
      && Boolean(authenticationSettings.privacyVersion)
      && options.authenticationLegalDocuments !== undefined;
    const passwordRecoveryAvailable =
      passwordLogin
      && authenticationSettings.emailDeliveryEnabled
      && options.emailTransport !== undefined;
    const providers = [
      ...(options.providers.google
        ? [{
            id: "google" as const,
            label: "Continue with Google",
            login_url: "/auth/google"
          }]
        : []),
      ...(options.providers.github
        ? [{
            id: "github" as const,
            label: "Continue with GitHub",
            login_url: "/auth/github"
          }]
        : [])
    ];
    const provider = options.providers.tailscale
      ? "tailscale"
      : options.providers.github
        ? "github"
        : options.providers.google
          ? "google"
          : options.providers.development
            ? "development"
            : "session";
    return {
      provider,
      providers,
      registration: authenticationSettings.registrationMode,
      development_login: options.providers.development,
      ...(passwordLogin
        ? {
            password_login: true,
            ...(passwordRecoveryAvailable
              ? { password_recovery: true }
              : {}),
            ...(passwordRegistration
              ? {
                  password_registration: true,
                  agreements: {
                    terms: {
                      version: authenticationSettings.termsVersion!,
                      url: options.authenticationLegalDocuments!.termsUrl
                    },
                    privacy: {
                      version: authenticationSettings.privacyVersion!,
                      url: options.authenticationLegalDocuments!.privacyUrl
                    }
                  }
                }
              : {})
          }
        : {}),
      ...(providers.length === 1 ? { login_url: providers[0].login_url } : {})
    };
  });

  app.post("/v1/auth/password/signup", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordAuthenticationUnavailableError();
    }
    if (!options.authenticationLegalDocuments) {
      throw new AuthenticationPolicyIncompleteError();
    }
    const input = z.object({
      invitation_token: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(100),
      password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES),
      terms_version: z.string().min(1).max(100),
      privacy_version: z.string().min(1).max(100)
    }).strict().parse(request.body);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.signup.token",
          key: input.invitation_token,
          rule: PASSWORD_SIGNUP_TOKEN_LIMIT
        },
        {
          scope: "password.signup.ip",
          key: request.ip,
          rule: PASSWORD_SIGNUP_IP_LIMIT
        },
        {
          scope: "password.signup.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const session = await passwordAccounts.acceptInvitation({
      invitationToken: input.invitation_token,
      name: input.name,
      password: input.password,
      termsVersion: input.terms_version,
      privacyVersion: input.privacy_version,
      clientName: sessionClientName(request.headers["user-agent"])
    });
    setSessionCookie(reply, session.token, options.publicUrl);
    return reply.code(201).send({ user: session.user });
  });

  app.post("/v1/auth/password/invitation", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordAuthenticationUnavailableError();
    }
    if (!options.authenticationLegalDocuments) {
      throw new AuthenticationPolicyIncompleteError();
    }
    const input = z.object({
      invitation_token: z.string().min(1).max(200)
    }).strict().parse(request.body);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.signup.token",
          key: input.invitation_token,
          rule: PASSWORD_SIGNUP_TOKEN_LIMIT
        },
        {
          scope: "password.signup.ip",
          key: request.ip,
          rule: PASSWORD_SIGNUP_IP_LIMIT
        },
        {
          scope: "password.signup.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const invitation = await passwordAccounts.invitationDetails(
      input.invitation_token
    );
    return {
      invitation: {
        email: invitation.email,
        expires_at: invitation.expiresAt.toISOString(),
        terms_version: invitation.termsVersion,
        privacy_version: invitation.privacyVersion
      }
    };
  });

  app.post("/v1/auth/password/login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordAuthenticationUnavailableError();
    }
    const input = z.object({
      email: z.email().max(320),
      password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES)
    }).strict().parse(request.body);
    const normalizedEmail = normalizeEmailAddress(input.email);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.login.email",
          key: normalizedEmail,
          rule: PASSWORD_LOGIN_EMAIL_LIMIT
        },
        {
          scope: "password.login.ip",
          key: request.ip,
          rule: PASSWORD_LOGIN_IP_LIMIT
        },
        {
          scope: "password.login.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const session = await passwordAccounts.authenticate({
      email: normalizedEmail,
      password: input.password,
      clientName: sessionClientName(request.headers["user-agent"])
    });
    setSessionCookie(reply, session.token, options.publicUrl);
    return { user: session.user };
  });

  app.post("/v1/auth/password/recovery", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl);
    if (!authenticationRateLimiter || !options.emailTransport) {
      throw new PasswordRecoveryUnavailableError();
    }
    const input = z.object({
      email: z.email().max(320)
    }).strict().parse(request.body);
    const normalizedEmail = normalizeEmailAddress(input.email);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.recovery.email",
          key: normalizedEmail,
          rule: PASSWORD_RECOVERY_EMAIL_LIMIT
        },
        {
          scope: "password.recovery.ip",
          key: request.ip,
          rule: PASSWORD_RECOVERY_IP_LIMIT
        },
        {
          scope: "password.recovery.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const reset = await passwordRecovery.create(normalizedEmail);
    reply.code(202).send({
      accepted: true,
      message: "If an account uses that email, a password reset link is on its way."
    });
    if (!reset) return reply;

    let delivery:
      | {
          status: "sent";
          provider: string;
          messageId: string;
        }
      | {
          status: "failed";
          provider: string;
          code: string;
          retryable: boolean;
        };
    try {
      const sent = await sendPasswordResetEmail(options.emailTransport, {
        challengeId: reset.challengeId,
        to: reset.email,
        resetUrl:
          `${options.publicUrl}/reset-password#reset=${encodeURIComponent(reset.token)}`,
        expiresAt: reset.expiresAt
      });
      delivery = {
        status: "sent",
        provider: sent.provider,
        messageId: sent.messageId
      };
    } catch (error) {
      delivery = {
        status: "failed",
        provider: error instanceof EmailDeliveryError ? "resend" : "unknown",
        code: error instanceof EmailDeliveryError
          ? error.code
          : "unexpected_error",
        retryable: error instanceof EmailDeliveryError && error.retryable
      };
      request.log.error({
        challenge_id: reset.challengeId,
        provider: delivery.provider,
        provider_code: delivery.code,
        retryable: delivery.retryable
      }, "Password reset email delivery failed");
    }
    try {
      await passwordRecovery.recordDelivery(
        reset.challengeId,
        reset.userId,
        delivery
      );
    } catch (error) {
      request.log.error({
        err: error,
        challenge_id: reset.challengeId
      }, "Password reset delivery audit failed");
    }
    return reply;
  });

  app.post("/v1/auth/password/reset", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordRecoveryUnavailableError();
    }
    const input = z.object({
      reset_token: z.string().min(1).max(200),
      password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES)
    }).strict().parse(request.body);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.reset.token",
          key: input.reset_token,
          rule: PASSWORD_RESET_TOKEN_LIMIT
        },
        {
          scope: "password.reset.ip",
          key: request.ip,
          rule: PASSWORD_RECOVERY_IP_LIMIT
        },
        {
          scope: "password.reset.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const session = await passwordRecovery.complete({
      token: input.reset_token,
      password: input.password,
      clientName: sessionClientName(request.headers["user-agent"])
    });
    setSessionCookie(reply, session.token, options.publicUrl);
    return {
      user: session.user,
      other_sessions_signed_out: true
    };
  });
}

async function consumeAuthenticationLimits(
  limiter: AuthRateLimiter,
  attempts: AuthenticationLimitAttempt[],
  reply: FastifyReply
): Promise<boolean> {
  let retryAfterSeconds = 0;
  for (const attempt of attempts) {
    const decision = await limiter.consume(
      attempt.scope,
      attempt.key,
      attempt.rule
    );
    if (!decision.allowed) {
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        decision.retryAfterSeconds
      );
    }
  }
  if (retryAfterSeconds === 0) return true;
  reply.header("retry-after", String(retryAfterSeconds));
  await reply.code(429).send(apiError(
    "authentication_throttled",
    "Too many authentication attempts. Please try again later."
  ));
  return false;
}
