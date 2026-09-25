import type { DatabasePool } from "./db.js";
import {
  isoTimestamp,
  reportWindowDays
} from "./auth-admin-compatibility.js";
import { invitationStatus } from "./instance-admin-invitations.js";

// Operator-only product usage report. Every figure is derived from rows the
// control plane already keeps to operate: no collection content, path, query,
// or per-operation record is read. docs/usage-report.md defines each figure.

interface UsageReportContext {
  db: DatabasePool;
}

type Timestamp = Date | string;

const DAY_MS = 24 * 60 * 60 * 1_000;

interface GrantRow {
  id: string;
  user_id: string;
  application_id: string;
  hosted_collection_id: string | null;
  created_at: Timestamp;
  activated_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

interface ApplicationUsage {
  name: string;
  distribution: string;
  named_at: number;
  active_grants: number;
  local_active_grants: number;
  hosted_active_grants: number;
  users_with_active_grant: Set<string>;
  active_users_in_window: Set<string>;
  approved_in_window: number;
  revoked_in_window: number;
  consent: ConsentCounts;
}

interface ConsentCounts {
  started: number;
  approved: number;
  denied: number;
  abandoned: number;
  abandoned_before_sign_in: number;
  pending: number;
}

export async function usageReport(
  argv: string[],
  context: UsageReportContext,
  invalid: (message: string) => never
): Promise<unknown> {
  const windowDays = reportWindowDays(argv, "Usage", invalid);
  const generatedAt = new Date();
  const now = generatedAt.getTime();
  const since = new Date(now - windowDays * DAY_MS);
  const start = since.getTime();
  const { db } = context;
  const [
    users,
    emailIdentities,
    externalIdentities,
    betaRequests,
    invitations,
    connectors,
    localCollections,
    hostedCollections,
    applications,
    grants,
    tokenGrants,
    transports,
    authorizations,
    pairings
  ] = await Promise.all([
    db.query<{ id: string; created_at: Timestamp; suspended_at: Timestamp | null }>(
      "SELECT id, created_at, suspended_at FROM users"
    ),
    db.query<{ user_id: string; normalized_email: string }>(
      "SELECT user_id, normalized_email FROM email_identities WHERE retired_at IS NULL"
    ),
    db.query<{ user_id: string; normalized_email: string }>(
      `SELECT user_id, normalized_email FROM external_identities
       WHERE email_verified = true AND normalized_email IS NOT NULL`
    ),
    db.query<{
      normalized_email: string;
      invitation_id: string | null;
      invited_at: Timestamp | null;
      requested_at: Timestamp;
    }>(
      `SELECT normalized_email, invitation_id, invited_at, requested_at
       FROM beta_access_requests`
    ),
    db.query<{
      id: string;
      accepted_at: Timestamp | null;
      revoked_at: Timestamp | null;
      expires_at: Timestamp;
    }>("SELECT id, accepted_at, revoked_at, expires_at FROM invitations"),
    db.query<{ user_id: string }>("SELECT user_id FROM connectors"),
    db.query<{
      user_id: string;
      removed_at: Timestamp | null;
      created_at: Timestamp | null;
    }>("SELECT user_id, removed_at, created_at FROM collections"),
    db.query<{ user_id: string; created_at: Timestamp }>(
      "SELECT user_id, created_at FROM hosted_collections"
    ),
    db.query<{
      id: string;
      canonical_identity: string;
      family_identity: string;
      name: string;
      distribution: string;
      updated_at: Timestamp;
    }>(
      `SELECT id, canonical_identity, family_identity, name, distribution, updated_at
       FROM applications`
    ),
    db.query<GrantRow>(
      `SELECT id, user_id, application_id, hosted_collection_id,
              created_at, activated_at, revoked_at
       FROM grants`
    ),
    // Access tokens last one hour, so an application using a grant through the
    // relay or a hosted collection refreshes here at least hourly.
    db.query<{ grant_id: string }>(
      "SELECT DISTINCT grant_id FROM access_tokens WHERE created_at >= $1",
      [since]
    ),
    // Direct same-computer use never refreshes; connectors report only
    // per-account protocol counts, which is the whole direct signal.
    db.query<{ user_id: string; surface: "direct" | "relay" | "hosted" }>(
      `SELECT user_id, surface FROM protocol_usage_telemetry
       WHERE last_seen_at >= $1`,
      [since]
    ),
    // Authorization lifetimes are capped at 15 minutes, so expiry dates a
    // request closely enough for a reporting window.
    db.query<{
      user_id: string | null;
      application_id: string;
      expires_at: Timestamp;
      completed_at: Timestamp | null;
      denied_at: Timestamp | null;
    }>(
      `SELECT user_id, application_id, expires_at, completed_at, denied_at
       FROM authorization_requests WHERE expires_at >= $1`,
      [since]
    ),
    db.query<{
      created_at: Timestamp;
      approved_at: Timestamp | null;
      consumed_at: Timestamp | null;
      expires_at: Timestamp;
    }>(
      `SELECT created_at, approved_at, consumed_at, expires_at
       FROM pairing_requests WHERE created_at >= $1`,
      [since]
    )
  ]);

  const pairedUsers = new Set(connectors.rows.map((row) => row.user_id));
  const collectionUsers = new Set([
    ...localCollections.rows.map((row) => row.user_id),
    ...hostedCollections.rows.map((row) => row.user_id)
  ]);
  const grantsById = new Map(grants.rows.map((grant) => [grant.id, grant]));
  const grantUsers = new Set(
    grants.rows.filter((grant) => grant.activated_at).map((grant) => grant.user_id)
  );
  const activeUsers = new Set(transports.rows.map((row) => row.user_id));
  for (const { grant_id } of tokenGrants.rows) {
    const grant = grantsById.get(grant_id);
    if (grant) activeUsers.add(grant.user_id);
  }
  const activation = (userIds: string[]) => ({
    accounts: userIds.length,
    paired_computer: userIds.filter((id) => pairedUsers.has(id)).length,
    collection: userIds.filter((id) => collectionUsers.has(id)).length,
    grant: userIds.filter((id) => grantUsers.has(id)).length,
    active_in_window: userIds.filter((id) => activeUsers.has(id)).length
  });
  const userCreatedAt = new Map(
    users.rows.map((user) => [user.id, instant(user.created_at)])
  );
  const recentUserIds = users.rows
    .filter((user) => instant(user.created_at) >= start)
    .map((user) => user.id);

  const userByEmail = new Map<string, string>();
  for (const identity of [...emailIdentities.rows, ...externalIdentities.rows]) {
    if (!userByEmail.has(identity.normalized_email)) {
      userByEmail.set(identity.normalized_email, identity.user_id);
    }
  }
  const invitationsById = new Map(invitations.rows.map((row) => [row.id, row]));
  const invitationCounts = { active: 0, accepted: 0, revoked: 0, expired: 0, missing: 0 };
  const betaSignupIds = new Set<string>();
  const invitedSignupIds = new Set<string>();
  let invitedRequests = 0;
  let preexistingAccounts = 0;
  for (const request of betaRequests.rows) {
    if (request.invited_at) invitedRequests += 1;
    const invitation = request.invitation_id
      ? invitationsById.get(request.invitation_id)
      : undefined;
    if (invitation) invitationCounts[invitationStatus(invitation)] += 1;
    else if (request.invited_at) invitationCounts.missing += 1;
    const userId = userByEmail.get(request.normalized_email);
    if (!userId) continue;
    if (userCreatedAt.get(userId)! >= instant(request.requested_at)) {
      betaSignupIds.add(userId);
      if (request.invited_at) invitedSignupIds.add(userId);
    } else {
      preexistingAccounts += 1;
    }
  }

  const consentTotals = emptyConsent();
  const applicationFamily = new Map<string, string>();
  const usage = new Map<string, ApplicationUsage>();
  for (const application of applications.rows) {
    const family = application.family_identity || application.canonical_identity;
    applicationFamily.set(application.id, family);
    const namedAt = instant(application.updated_at);
    const existing = usage.get(family);
    if (!existing) {
      usage.set(family, {
        name: application.name,
        distribution: application.distribution,
        named_at: namedAt,
        active_grants: 0,
        local_active_grants: 0,
        hosted_active_grants: 0,
        users_with_active_grant: new Set(),
        active_users_in_window: new Set(),
        approved_in_window: 0,
        revoked_in_window: 0,
        consent: emptyConsent()
      });
    } else if (namedAt > existing.named_at) {
      existing.name = application.name;
      existing.distribution = application.distribution;
      existing.named_at = namedAt;
    }
  }
  const usageFor = (applicationId: string) =>
    usage.get(applicationFamily.get(applicationId)!)!;
  for (const grant of grants.rows) {
    if (!grant.activated_at) continue;
    const entry = usageFor(grant.application_id);
    if (instant(grant.created_at) >= start) entry.approved_in_window += 1;
    if (grant.revoked_at) {
      if (instant(grant.revoked_at) >= start) entry.revoked_in_window += 1;
      continue;
    }
    entry.active_grants += 1;
    entry.users_with_active_grant.add(grant.user_id);
    if (grant.hosted_collection_id) entry.hosted_active_grants += 1;
    else entry.local_active_grants += 1;
  }
  for (const { grant_id } of tokenGrants.rows) {
    const grant = grantsById.get(grant_id);
    if (grant) usageFor(grant.application_id).active_users_in_window.add(grant.user_id);
  }
  for (const request of authorizations.rows) {
    const outcome: keyof ConsentCounts = request.completed_at
      ? "approved"
      : request.denied_at
        ? "denied"
        : instant(request.expires_at) <= now
          ? "abandoned"
          : "pending";
    for (const counts of [consentTotals, usageFor(request.application_id).consent]) {
      counts.started += 1;
      counts[outcome] += 1;
      if (outcome === "abandoned" && request.user_id === null) {
        counts.abandoned_before_sign_in += 1;
      }
    }
  }

  const betaSignups = [...betaSignupIds];
  const pairing = { started: 0, approved: 0, completed: 0, expired_unapproved: 0, pending: 0 };
  for (const request of pairings.rows) {
    pairing.started += 1;
    if (request.consumed_at) pairing.completed += 1;
    if (request.approved_at) pairing.approved += 1;
    else if (instant(request.expires_at) <= now) pairing.expired_unapproved += 1;
    else pairing.pending += 1;
  }

  const activeLocal = localCollections.rows.filter((row) => !row.removed_at);
  const surfaceUsers = (surface: string) => new Set(
    transports.rows.filter((row) => row.surface === surface).map((row) => row.user_id)
  ).size;
  const recentSignups = betaSignups
    .filter((userId) => userCreatedAt.get(userId)! >= start)
    .sort((left, right) => userCreatedAt.get(right)! - userCreatedAt.get(left)!);

  return {
    schema_version: 1,
    generated_at: generatedAt.toISOString(),
    window: { days: windowDays, starts_at: since.toISOString() },
    accounts: {
      total: users.rows.length,
      suspended: users.rows.filter((user) => user.suspended_at).length,
      created_in_window: recentUserIds.length
    },
    activation: {
      all_accounts: activation(users.rows.map((user) => user.id)),
      created_in_window: activation(recentUserIds)
    },
    beta: {
      requests: {
        total: betaRequests.rows.length,
        pending: betaRequests.rows.length - invitedRequests,
        invited: invitedRequests
      },
      invitations: invitationCounts,
      accounts: {
        created_from_beta: betaSignups.length,
        created_in_window: recentSignups.length,
        preexisting: preexistingAccounts,
        request_to_signup_percent: percentage(betaSignups.length, betaRequests.rows.length),
        invited_to_signup_percent: percentage(invitedSignupIds.size, invitedRequests)
      },
      activation: activation(betaSignups),
      recent_signups: recentSignups.map((userId) => ({
        created_at: new Date(userCreatedAt.get(userId)!).toISOString(),
        paired_computer: pairedUsers.has(userId),
        collection: collectionUsers.has(userId),
        grant: grantUsers.has(userId),
        active_in_window: activeUsers.has(userId)
      }))
    },
    pairing,
    consent: consentTotals,
    collections: {
      local: {
        registered: activeLocal.length,
        registered_in_window: activeLocal.filter((row) =>
          row.created_at !== null && instant(row.created_at) >= start
        ).length,
        registration_time_unknown: activeLocal.filter((row) => row.created_at === null).length
      },
      hosted: {
        total: hostedCollections.rows.length,
        created_in_window: hostedCollections.rows.filter((row) =>
          instant(row.created_at) >= start
        ).length
      }
    },
    transport_users_in_window: {
      direct: surfaceUsers("direct"),
      relay: surfaceUsers("relay"),
      hosted: surfaceUsers("hosted")
    },
    applications: [...usage.entries()]
      .filter(([, entry]) =>
        entry.active_grants > 0
        || entry.approved_in_window > 0
        || entry.revoked_in_window > 0
        || entry.consent.started > 0
      )
      .map(([family, entry]) => ({
        family,
        name: entry.name,
        distribution: entry.distribution,
        active_users_in_window: entry.active_users_in_window.size,
        users_with_active_grant: entry.users_with_active_grant.size,
        active_grants: entry.active_grants,
        local_active_grants: entry.local_active_grants,
        hosted_active_grants: entry.hosted_active_grants,
        approved_in_window: entry.approved_in_window,
        revoked_in_window: entry.revoked_in_window,
        consent: entry.consent
      }))
      .sort((left, right) =>
        right.active_users_in_window - left.active_users_in_window
        || right.users_with_active_grant - left.users_with_active_grant
        || left.name.localeCompare(right.name)
      )
  };
}

function emptyConsent(): ConsentCounts {
  return {
    started: 0,
    approved: 0,
    denied: 0,
    abandoned: 0,
    abandoned_before_sign_in: 0,
    pending: 0
  };
}

function instant(value: Timestamp): number {
  return Date.parse(isoTimestamp(value));
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator * 1000) / denominator) / 10;
}
