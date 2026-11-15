import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import {
  BETA_ENTITLEMENT_PROFILE,
  OPEN_BETA_ENTITLEMENT_PROFILE
} from "../account/entitlements.js";
import type { TransactionalEmail } from "./email.js";
import { scheduleEmail, type EmailRenderContext } from "./scheduled-email.js";

/**
 * Announcements are one-off account emails whose copy an operator stores in
 * `email_announcements`, so changing it needs no deployment. Each stored
 * version is immutable: a job names the version it was queued with
 * (`template_version`) and renders that version when it is due, so every
 * recipient gets exactly what the operator previewed.
 */
const MESSAGE_KIND_PREFIX = "announcement.";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PLACEHOLDER_PATTERN = /\{([^{}\s]*)\}/gu;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20_000;

export class AnnouncementInputError extends Error {}

export interface Announcement {
  slug: string;
  version: number;
  subject: string;
  /** Paragraphs separated by blank lines; `{name}` is the recipient's name. */
  body: string;
  /** The body accounts with a beta grant receive instead, when set. */
  beta_body: string | null;
  created_at: Date | string;
}

export interface AnnouncementInput {
  slug: string;
  subject: string;
  body: string;
  betaBody: string | null;
}

export function announcementSlug(value: string): string {
  if (!SLUG_PATTERN.test(value)) {
    throw new AnnouncementInputError(
      "--announcement must be 1 to 64 lowercase letters, digits or hyphens."
    );
  }
  return value;
}

/** The scheduled-email kind for an announcement, or null for any other kind. */
export function announcementSlugFromKind(messageKind: string): string | null {
  return messageKind.startsWith(MESSAGE_KIND_PREFIX)
    ? messageKind.slice(MESSAGE_KIND_PREFIX.length)
    : null;
}

function validate(input: AnnouncementInput): void {
  announcementSlug(input.slug);
  if (
    !input.subject.trim()
    || input.subject.length > MAX_SUBJECT_LENGTH
    || /[\r\n]/u.test(input.subject)
  ) {
    throw new AnnouncementInputError(
      `--subject must be one line of 1 to ${MAX_SUBJECT_LENGTH} characters.`
    );
  }
  for (const [name, body] of [["body", input.body], ["beta-body", input.betaBody]] as const) {
    if (body === null) continue;
    if (!body.trim() || body.length > MAX_BODY_LENGTH) {
      throw new AnnouncementInputError(
        `--${name} must have 1 to ${MAX_BODY_LENGTH} characters.`
      );
    }
    for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
      if (match[1] !== "name") {
        throw new AnnouncementInputError(
          `--${name} has an unknown placeholder ${match[0]}; only {name} is supported.`
        );
      }
    }
  }
}

/**
 * Stores the copy as the announcement's next version. Copy identical to the
 * latest version returns that version instead, so a retried create is safe.
 */
export async function createAnnouncement(
  db: DatabasePool,
  input: AnnouncementInput,
  mutation: { operationId: string; actor: string; reason: string }
): Promise<{ announcement: Announcement; created: boolean }> {
  validate(input);
  const latest = await readAnnouncement(db, input.slug, null);
  if (
    latest
    && latest.subject === input.subject
    && latest.body === input.body
    && latest.beta_body === input.betaBody
  ) {
    return { announcement: latest, created: false };
  }
  const version = (latest?.version ?? 0) + 1;
  // A concurrent create of the same version fails on the primary key.
  const inserted = await db.query<Announcement>(
    `INSERT INTO email_announcements (slug, version, subject, body, beta_body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING slug, version, subject, body, beta_body, created_at`,
    [input.slug, version, input.subject, input.body, input.betaBody]
  );
  await audit(db, "email.announcement_created", input.slug, null, mutation, { version });
  return { announcement: inserted.rows[0]!, created: true };
}

/** A stored version, or the latest one when `version` is null. */
export async function readAnnouncement(
  db: DatabaseQueryable,
  slug: string,
  version: number | null
): Promise<Announcement | null> {
  const result = await db.query<Announcement>(
    `SELECT slug, version, subject, body, beta_body, created_at
     FROM email_announcements
     WHERE slug = $1${version === null ? "" : " AND version = $2"}
     ORDER BY version DESC
     LIMIT 1`,
    version === null ? [slug] : [slug, version]
  );
  return result.rows[0] ?? null;
}

export async function hasBetaGrant(db: DatabaseQueryable, userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM account_entitlement_grants
     WHERE user_id = $1 AND profile_code IN ($2, $3) AND revoked_at IS NULL
       AND (ends_at IS NULL OR ends_at > now())
     LIMIT 1`,
    [userId, BETA_ENTITLEMENT_PROFILE, OPEN_BETA_ENTITLEMENT_PROFILE]
  );
  return result.rows.length > 0;
}

/** The subject and paragraphs one recipient gets from a stored version. */
export function announcementContent(
  announcement: Announcement,
  name: string,
  beta: boolean
): { subject: string; paragraphs: string[] } {
  const body = beta && announcement.beta_body !== null
    ? announcement.beta_body
    : announcement.body;
  return {
    subject: announcement.subject,
    paragraphs: body
      .replaceAll("\r\n", "\n")
      .split(/\n[ \t]*\n/u)
      .map((paragraph) => paragraph.trim().replaceAll("{name}", name))
      .filter(Boolean)
  };
}

export async function renderAnnouncement(
  db: DatabaseQueryable,
  context: EmailRenderContext,
  slug: string,
  render: (subject: string, paragraphs: string[]) => TransactionalEmail
): Promise<TransactionalEmail> {
  const announcement = await readAnnouncement(db, slug, context.templateVersion);
  if (!announcement) throw new TypeError("Scheduled email template is unavailable.");
  const content = announcementContent(
    announcement,
    context.name,
    await hasBetaGrant(db, context.userId)
  );
  return render(content.subject, content.paragraphs);
}

interface Recipient {
  user_id: string;
  email_identity_id: string;
  scheduled: boolean;
}

export interface AnnouncementCounts {
  /** Recipients not queued before; queued by `schedule`. */
  recipients: number;
  already_scheduled: number;
}

function deduplicationKey(slug: string, userId: string): string {
  return `${MESSAGE_KIND_PREFIX}${slug}:${userId}`;
}

/**
 * The accounts an announcement goes to: unsuspended, with a verified primary
 * address. The worker checks suspension, the announcements preference and
 * suppression again when each message is due. `userId` narrows it to one
 * account, for a test send.
 */
async function recipients(
  db: DatabasePool,
  slug: string,
  userId: string | null
): Promise<Recipient[]> {
  const accounts = await db.query<{ user_id: string; email_identity_id: string }>(
    `SELECT account.id AS user_id, identity.id AS email_identity_id
     FROM users account
     JOIN email_identities identity
       ON identity.user_id = account.id AND identity.is_primary
          AND identity.retired_at IS NULL AND identity.verified_at IS NOT NULL
     WHERE account.suspended_at IS NULL${userId ? " AND account.id = $1" : ""}
     ORDER BY account.id`,
    userId ? [userId] : []
  );
  // Test sends share the kind but not the key, so they don't count.
  const scheduled = await db.query<{ user_id: string; deduplication_key: string }>(
    "SELECT user_id, deduplication_key FROM email_jobs WHERE message_kind = $1",
    [MESSAGE_KIND_PREFIX + slug]
  );
  const scheduledIds = new Set(scheduled.rows
    .filter((row) => row.deduplication_key === deduplicationKey(slug, row.user_id))
    .map((row) => row.user_id));
  return accounts.rows.map((row) => ({ ...row, scheduled: scheduledIds.has(row.user_id) }));
}

function count(rows: Recipient[]): AnnouncementCounts {
  const fresh = rows.filter((row) => !row.scheduled).length;
  return { recipients: fresh, already_scheduled: rows.length - fresh };
}

async function queue(
  db: DatabasePool,
  slug: string,
  version: number,
  recipient: Recipient,
  key: string
): Promise<boolean> {
  const queued = await scheduleEmail(db, {
    userId: recipient.user_id,
    emailIdentityId: recipient.email_identity_id,
    messageKind: MESSAGE_KIND_PREFIX + slug,
    templateVersion: version,
    category: "onboarding",
    deduplicationKey: key,
    scheduledFor: new Date()
  });
  return !queued.duplicate;
}

async function audit(
  db: DatabasePool,
  eventType: string,
  slug: string,
  userId: string | null,
  mutation: { operationId: string; actor: string; reason: string },
  details: Record<string, unknown>
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      randomUUID(),
      userId,
      eventType,
      slug,
      JSON.stringify({
        actor: mutation.actor,
        reason: mutation.reason,
        operation_id: mutation.operationId,
        ...details
      })
    ]
  );
}

async function requireAnnouncement(db: DatabasePool, slug: string): Promise<Announcement> {
  const announcement = await readAnnouncement(db, slug, null);
  if (!announcement) throw new AnnouncementInputError(`No announcement named ${slug}.`);
  return announcement;
}

export async function previewAnnouncement(
  db: DatabasePool,
  slug: string,
  userId: string | null
): Promise<AnnouncementCounts & { version: number }> {
  const announcement = await requireAnnouncement(db, slug);
  return { version: announcement.version, ...count(await recipients(db, slug, userId)) };
}

/**
 * Queues the latest version for each recipient, due now. One deduplication key
 * per account and announcement means a rerun queues only accounts added since,
 * and a later version never reaches an account queued with an earlier one.
 */
export async function scheduleAnnouncement(
  db: DatabasePool,
  slug: string,
  userId: string | null,
  mutation: { operationId: string; actor: string; reason: string }
): Promise<AnnouncementCounts & { operation_id: string; version: number }> {
  const announcement = await requireAnnouncement(db, slug);
  const rows = await recipients(db, slug, userId);
  for (const row of rows) {
    if (row.scheduled) continue;
    // False when a concurrent run queued it between the listing and the insert.
    if (!await queue(db, slug, announcement.version, row, deduplicationKey(slug, row.user_id))) {
      row.scheduled = true;
    }
  }
  const counts = count(rows);
  await audit(db, "email.announcement_scheduled", slug, userId, mutation,
    { version: announcement.version, ...counts });
  return { operation_id: mutation.operationId, version: announcement.version, ...counts };
}

/**
 * Queues the latest version for one account as a test. It doesn't count as
 * that account's announcement, and each version can be tested once per account.
 */
export async function testSendAnnouncement(
  db: DatabasePool,
  slug: string,
  userId: string,
  mutation: { operationId: string; actor: string; reason: string }
): Promise<{ operation_id: string; version: number; queued: boolean }> {
  const announcement = await requireAnnouncement(db, slug);
  const [recipient] = await recipients(db, slug, userId);
  if (!recipient) {
    throw new AnnouncementInputError(
      "That account is suspended or has no verified primary address."
    );
  }
  const queued = await queue(db, slug, announcement.version, recipient,
    `${deduplicationKey(slug, userId)}:test-v${announcement.version}`);
  await audit(db, "email.announcement_test_scheduled", slug, userId, mutation,
    { version: announcement.version, queued });
  return { operation_id: mutation.operationId, version: announcement.version, queued };
}
