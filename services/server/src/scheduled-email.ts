import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "./database-types.js";
import {
  EmailDeliveryError,
  type EmailTransport,
  type TransactionalEmail
} from "./email.js";
import { randomToken, tokenHash } from "./security.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 8;
const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;

// "onboarding" covers the welcome message and later announcements; it is sent
// under the announcements preference. "product" is opt-in.
export type EmailCategory = "essential" | "onboarding" | "product";

export interface ScheduleEmailInput {
  userId: string;
  emailIdentityId: string;
  messageKind: string;
  templateVersion: number;
  category: EmailCategory;
  deduplicationKey: string;
  scheduledFor: Date;
}

export interface EmailRenderContext {
  userId: string;
  name: string;
  email: string;
  messageKind: string;
  templateVersion: number;
  /** Present for every non-essential message; the body must include it. */
  unsubscribeUrl: string | null;
}

export type EmailRenderer = (
  context: EmailRenderContext
) => TransactionalEmail;

interface EmailJobRow {
  id: string;
  user_id: string;
  email_identity_id: string;
  message_kind: string;
  template_version: number;
  category: EmailCategory;
  idempotency_key: string;
  attempt_count: number;
  created_at: Date | string;
}

interface EmailRecipientRow {
  name: string;
  email: string;
  verified_at: Date | string | null;
  retired_at: Date | string | null;
  suspended_at: Date | string | null;
  onboarding_enabled: boolean | null;
  announcements_enabled: boolean | null;
  product_enabled: boolean | null;
  suppression_reason: string | null;
}

export async function scheduleEmail(
  db: DatabaseQueryable,
  input: ScheduleEmailInput
): Promise<{ id: string; duplicate: boolean }> {
  validateSchedule(input);
  const id = randomUUID();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO email_jobs
       (id, user_id, email_identity_id, message_kind, template_version,
        category, deduplication_key, idempotency_key, scheduled_for,
        next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      id,
      input.userId,
      input.emailIdentityId,
      input.messageKind,
      input.templateVersion,
      input.category,
      input.deduplicationKey,
      `email/${id}`,
      input.scheduledFor
    ]
  );
  if (inserted.rows[0]) return { id, duplicate: false };
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM email_jobs WHERE deduplication_key = $1",
    [input.deduplicationKey]
  );
  return { id: existing.rows[0]!.id, duplicate: true };
}

export class ScheduledEmailWorker {
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<number> | null = null;

  constructor(
    private readonly db: DatabasePool,
    private readonly transport: EmailTransport,
    private readonly render: EmailRenderer,
    private readonly publicUrl: string,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.drainOnce().catch(this.onError),
      this.pollIntervalMs
    );
    this.timer.unref();
    void this.drainOnce().catch(this.onError);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  drainOnce(limit = 25): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = this.performDrain(Math.max(1, Math.min(limit, 100)))
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  private async performDrain(limit: number): Promise<number> {
    const ready = await this.db.query<{ id: string }>(
      `SELECT id FROM email_jobs
       WHERE next_attempt_at <= now()
         AND (
           state = 'scheduled'
           OR (state = 'sending' AND lease_expires_at <= now())
         )
       ORDER BY next_attempt_at, id
       LIMIT $1`,
      [limit]
    );
    let processed = 0;
    for (const candidate of ready.rows) {
      const claimed = await this.claim(candidate.id);
      if (!claimed) continue;
      processed += 1;
      await this.deliver(claimed);
    }
    return processed;
  }

  private async claim(id: string): Promise<EmailJobRow | null> {
    const leaseToken = randomUUID();
    const claimed = await this.db.query<EmailJobRow>(
      `UPDATE email_jobs SET
         state = 'sending', lease_token = $2,
         lease_expires_at = now() + interval '2 minutes',
         attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1
         AND next_attempt_at <= now()
         AND (
           state = 'scheduled'
           OR (state = 'sending' AND lease_expires_at <= now())
         )
       RETURNING id, user_id, email_identity_id, message_kind,
                 template_version, category, idempotency_key,
                 attempt_count, created_at`,
      [id, leaseToken]
    );
    const job = claimed.rows[0];
    if (!job) return null;
    await this.db.query(
      `INSERT INTO email_delivery_attempts
         (id, job_id, attempt_number, state)
       VALUES ($1, $2, $3, 'started')`,
      [randomUUID(), job.id, job.attempt_count]
    );
    return job;
  }

  private async deliver(job: EmailJobRow): Promise<void> {
    const recipient = await this.recipient(job);
    if (!recipient || !eligible(job.category, recipient)) {
      await this.cancel(job, recipient ? "preference_or_suppression" : "recipient_unavailable");
      return;
    }
    // A fresh token per attempt keeps tokens hashed at rest. Every issued
    // token stays valid, so a retry the provider deduplicates to an earlier
    // rendering still carries a working link.
    const preference = categoryPreference(job.category);
    const links = preference
      ? await issueUnsubscribeLinks(this.db, this.publicUrl, job.user_id, preference)
      : null;
    const unsubscribeUrl = links?.page ?? null;
    let message: TransactionalEmail;
    try {
      message = this.render({
        userId: job.user_id,
        name: recipient.name,
        email: recipient.email,
        messageKind: job.message_kind,
        templateVersion: job.template_version,
        unsubscribeUrl
      });
      if (links) {
        if (!message.text.includes(links.page)) {
          throw new TypeError("Optional email must include its unsubscribe link.");
        }
        message = {
          ...message,
          headers: {
            "List-Unsubscribe": `<${links.oneClick}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
          }
        };
      }
    } catch {
      await this.fail(job, new EmailDeliveryError("template_error", false));
      return;
    }
    try {
      const delivery = await this.transport.send(message, job.idempotency_key);
      await this.db.query(
        `UPDATE email_jobs SET
           state = 'accepted', provider = $3, provider_message_id = $4,
           accepted_at = now(), lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, updated_at = now()
         WHERE id = $1 AND state = 'sending' AND attempt_count = $2`,
        [job.id, job.attempt_count, delivery.provider, delivery.messageId]
      );
      await this.finishAttempt(
        job,
        "accepted",
        delivery.provider,
        delivery.messageId
      );
    } catch (error) {
      await this.fail(
        job,
        error instanceof EmailDeliveryError
          ? error
          : new EmailDeliveryError("unknown_error", false)
      );
    }
  }

  private async recipient(job: EmailJobRow): Promise<EmailRecipientRow | null> {
    const result = await this.db.query<EmailRecipientRow>(
      `SELECT account.name, account.suspended_at, identity.email,
              identity.verified_at, identity.retired_at,
              preferences.onboarding_enabled,
              preferences.announcements_enabled, preferences.product_enabled,
              suppression.reason AS suppression_reason
       FROM users account
       JOIN email_identities identity
         ON identity.id = $2 AND identity.user_id = account.id
       LEFT JOIN account_email_preferences preferences
         ON preferences.user_id = account.id
       LEFT JOIN email_suppressions suppression
         ON suppression.email_identity_id = identity.id
       WHERE account.id = $1`,
      [job.user_id, job.email_identity_id]
    );
    return result.rows[0] ?? null;
  }

  private async cancel(job: EmailJobRow, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE email_jobs SET state = 'cancelled', cancelled_at = now(),
              last_error_code = $3, lease_token = NULL,
              lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND state = 'sending' AND attempt_count = $2`,
      [job.id, job.attempt_count, reason]
    );
    await this.finishAttempt(job, "failed", null, null, reason);
  }

  private async fail(job: EmailJobRow, error: EmailDeliveryError): Promise<void> {
    const age = Date.now() - new Date(job.created_at).getTime();
    const uncertain = error.code === "network_error"
      && age >= PROVIDER_IDEMPOTENCY_WINDOW_MS;
    const retry = error.retryable && !uncertain && job.attempt_count < MAX_ATTEMPTS;
    const state = uncertain ? "uncertain" : retry ? "scheduled" : "failed";
    const delaySeconds = retry ? retryDelaySeconds(job.attempt_count) : 0;
    const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);
    await this.db.query(
      `UPDATE email_jobs SET state = $3,
              next_attempt_at = CASE WHEN $4
                THEN $5
                ELSE next_attempt_at END,
              last_error_code = $6, lease_token = NULL,
              lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND state = 'sending' AND attempt_count = $2`,
      [job.id, job.attempt_count, state, retry, nextAttemptAt, error.code]
    );
    await this.finishAttempt(
      job,
      uncertain ? "uncertain" : "failed",
      null,
      null,
      error.code
    );
  }

  private async finishAttempt(
    job: EmailJobRow,
    state: "accepted" | "failed" | "uncertain",
    provider: string | null,
    providerMessageId: string | null,
    errorCode: string | null = null
  ): Promise<void> {
    await this.db.query(
      `UPDATE email_delivery_attempts SET
         state = $3, provider = $4, provider_message_id = $5,
         error_code = $6, completed_at = now()
       WHERE job_id = $1 AND attempt_number = $2 AND state = 'started'`,
      [job.id, job.attempt_count, state, provider, providerMessageId, errorCode]
    );
  }
}

function eligible(category: EmailCategory, recipient: EmailRecipientRow): boolean {
  if (
    recipient.suspended_at
    || !recipient.verified_at
    || recipient.retired_at
    || recipient.suppression_reason
  ) return false;
  // onboarding_enabled predates the announcements preference and has no
  // writer; it is honoured only so an operator-set false still holds.
  if (category === "onboarding") {
    return (recipient.announcements_enabled ?? true)
      && (recipient.onboarding_enabled ?? true);
  }
  if (category === "product") return recipient.product_enabled ?? false;
  return true;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(6 * 60 * 60, 30 * 2 ** Math.max(0, attempt - 1));
}

function validateSchedule(input: ScheduleEmailInput): void {
  if (!/^[a-z][a-z0-9_.-]{0,99}$/u.test(input.messageKind)) {
    throw new TypeError("Scheduled email kind is invalid.");
  }
  if (!Number.isSafeInteger(input.templateVersion) || input.templateVersion < 1) {
    throw new TypeError("Scheduled email template version is invalid.");
  }
  if (!input.deduplicationKey || input.deduplicationKey.length > 200) {
    throw new TypeError("Scheduled email deduplication key is invalid.");
  }
  if (!Number.isFinite(input.scheduledFor.getTime())) {
    throw new TypeError("Scheduled email time is invalid.");
  }
}

// Optional email preferences and unsubscribe tokens.

type EmailPreference = "announcements" | "product_updates";

interface EmailPreferences {
  announcements: boolean;
  product_updates: boolean;
}

const UNSUBSCRIBE_TOKEN = /^uns_[A-Za-z0-9_-]{43}$/u;

/**
 * The preference a category's messages are sent under, or null for essential
 * account email, which cannot be turned off.
 */
function categoryPreference(category: EmailCategory): EmailPreference | null {
  if (category === "product") return "product_updates";
  if (category === "onboarding") return "announcements";
  return null;
}

/** Accounts without a preferences row receive the column defaults. */
export async function readEmailPreferences(
  db: DatabaseQueryable,
  userId: string
): Promise<EmailPreferences> {
  const result = await db.query<{
    announcements_enabled: boolean;
    product_enabled: boolean;
  }>(
    `SELECT announcements_enabled, product_enabled
     FROM account_email_preferences WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return {
    announcements: row?.announcements_enabled ?? true,
    product_updates: row?.product_enabled ?? false
  };
}

export async function updateEmailPreferences(
  db: DatabaseQueryable,
  userId: string,
  changes: Partial<EmailPreferences>
): Promise<EmailPreferences> {
  // An omitted preference keeps its current value, or the column default.
  const result = await db.query<{
    announcements_enabled: boolean;
    product_enabled: boolean;
  }>(
    `INSERT INTO account_email_preferences
       (user_id, announcements_enabled, product_enabled)
     VALUES ($1, COALESCE($2::boolean, true), COALESCE($3::boolean, false))
     ON CONFLICT (user_id) DO UPDATE SET
       announcements_enabled = COALESCE(
         $2::boolean, account_email_preferences.announcements_enabled
       ),
       product_enabled = COALESCE(
         $3::boolean, account_email_preferences.product_enabled
       ),
       updated_at = now()
     RETURNING announcements_enabled, product_enabled`,
    [userId, changes.announcements ?? null, changes.product_updates ?? null]
  );
  const row = result.rows[0]!;
  return {
    announcements: row.announcements_enabled,
    product_updates: row.product_enabled
  };
}

/**
 * Issues a token that turns off one preference for one account, as the two
 * links an optional message carries: a confirmation page in the portal for the
 * body (a scanner that opens it changes nothing) and the RFC 8058 one-click
 * target that mail clients POST to directly.
 */
async function issueUnsubscribeLinks(
  db: DatabaseQueryable,
  publicUrl: string,
  userId: string,
  preference: EmailPreference
): Promise<{ page: string; oneClick: string }> {
  const token = randomToken("uns");
  await db.query(
    `INSERT INTO email_unsubscribe_tokens (token_hash, user_id, preference)
     VALUES ($1, $2, $3)`,
    [tokenHash(token), userId, preference]
  );
  const page = new URL("/unsubscribe", publicUrl);
  page.hash = new URLSearchParams({ unsubscribe: token }).toString();
  const oneClick = new URL("/v1/email/unsubscribe", publicUrl);
  oneClick.searchParams.set("token", token);
  return { page: page.href, oneClick: oneClick.href };
}

/**
 * Turns off the preference a token was issued for. Redeeming a token again is
 * harmless, so tokens stay valid; they grant nothing beyond this.
 */
export async function redeemUnsubscribeToken(
  db: DatabaseQueryable,
  token: string
): Promise<EmailPreference | null> {
  if (!UNSUBSCRIBE_TOKEN.test(token)) return null;
  const result = await db.query<{ user_id: string; preference: EmailPreference }>(
    `SELECT user_id, preference FROM email_unsubscribe_tokens
     WHERE token_hash = $1`,
    [tokenHash(token)]
  );
  const row = result.rows[0];
  if (!row) return null;
  await updateEmailPreferences(db, row.user_id, { [row.preference]: false });
  return row.preference;
}
