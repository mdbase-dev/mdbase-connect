import type { DatabasePool } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";

interface CompatibilityReportContext {
  db: DatabasePool;
  hostedProvider?: HostedProviderClient;
}

function compatibilityWindowDays(
  argv: string[],
  invalid: (message: string) => never
): number {
  if (argv.length === 0) return 30;
  if (argv.length !== 2 || argv[0] !== "--days") {
    return invalid("Compatibility report accepts only --days <1-365>.");
  }
  const value = argv[1]!;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return invalid("--days must be a positive integer.");
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > 365) {
    return invalid("--days must not exceed 365.");
  }
  return days;
}

interface ProtocolTelemetryRow {
  user_id: string;
  surface: "direct" | "relay" | "hosted";
  protocol_version: number;
  sample_count: number | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

interface ProtocolAggregate {
  surface: "direct" | "relay" | "hosted";
  protocol_version: number;
  samples: number;
  users: Set<string>;
  first_seen_at: string;
  last_seen_at: string;
}

export async function compatibilityReport(
  argv: string[],
  context: CompatibilityReportContext,
  invalid: (message: string) => never
): Promise<unknown> {
  const windowDays = compatibilityWindowDays(argv, invalid);
  const generatedAt = new Date();
  const observationStart = new Date(
    generatedAt.getTime() - windowDays * 24 * 60 * 60 * 1_000
  );
  const [telemetry, connectors, grants, migration, hostedCollections, storageAccounts] =
    await Promise.all([
      context.db.query<ProtocolTelemetryRow>(
        `SELECT user_id, surface, protocol_version, sample_count,
                first_seen_at, last_seen_at
         FROM protocol_usage_telemetry
         WHERE protocol_axis = 'operation_transport' AND last_seen_at >= $1`,
        [observationStart]
      ),
      context.db.query<{
        user_id: string;
        connector_version: string | null;
        last_seen_at: Date | string;
      }>(
        `SELECT user_id, connector_version,
                COALESCE(last_seen_at, created_at) AS last_seen_at
         FROM connectors WHERE revoked_at IS NULL`
      ),
      context.db.query<{
        user_id: string;
        application_authorization: unknown;
      }>(
        `SELECT user_id, application_authorization
         FROM grants
         WHERE revoked_at IS NULL AND activated_at IS NOT NULL`
      ),
      context.db.query<{ applied_at: Date | string }>(
        `SELECT applied_at FROM schema_migrations
         WHERE id = '0020_protocol_usage_telemetry'`
      ),
      context.db.query<{ count: number | string }>(
        "SELECT count(*) AS count FROM hosted_collections"
      ),
      context.db.query<{ user_id: string; provider_account_id: string }>(
        "SELECT user_id, provider_account_id FROM account_storage_accounts"
      )
    ]);

  const aggregates = new Map<string, ProtocolAggregate>();
  for (const row of telemetry.rows) {
    addProtocolAggregate(aggregates, {
      surface: row.surface,
      protocolVersion: Number(row.protocol_version),
      samples: safeCount(row.sample_count, "protocol telemetry sample count"),
      userId: row.user_id,
      firstSeenAt: isoTimestamp(row.first_seen_at),
      lastSeenAt: isoTimestamp(row.last_seen_at)
    });
  }

  const hostedCollectionCount = safeCount(
    hostedCollections.rows[0]?.count ?? 0,
    "hosted collection count"
  );
  const providerReport = context.hostedProvider
    ? await context.hostedProvider.protocolUsage()
    : null;
  const userByProviderAccount = new Map(
    storageAccounts.rows.map((row) => [row.provider_account_id, row.user_id])
  );
  const unmappedHostedAccounts = new Set<string>();
  for (const entry of providerReport?.entries ?? []) {
    const lastSeenAt = isoTimestamp(entry.last_seen_at);
    if (new Date(lastSeenAt) < observationStart) continue;
    const userId = userByProviderAccount.get(entry.account_id);
    if (!userId) unmappedHostedAccounts.add(entry.account_id);
    addProtocolAggregate(aggregates, {
      surface: "hosted",
      protocolVersion: entry.protocol_version,
      samples: safeCount(entry.sample_count, "hosted protocol sample count"),
      userId,
      firstSeenAt: isoTimestamp(entry.first_seen_at),
      lastSeenAt
    });
  }

  const connectorVersions = new Map<string, {
    connectors: number;
    users: Set<string>;
    last_seen_at: string;
  }>();
  const beta55OrEarlierUsers = new Set<string>();
  const preBeta57Users = new Set<string>();
  const recentPreBeta57Users = new Set<string>();
  const unknownConnectorUsers = new Set<string>();
  for (const connector of connectors.rows) {
    const version = connector.connector_version ?? "unknown";
    const lastSeenAt = isoTimestamp(connector.last_seen_at);
    const aggregate = connectorVersions.get(version) ?? {
      connectors: 0,
      users: new Set<string>(),
      last_seen_at: lastSeenAt
    };
    aggregate.connectors += 1;
    aggregate.users.add(connector.user_id);
    if (lastSeenAt > aggregate.last_seen_at) aggregate.last_seen_at = lastSeenAt;
    connectorVersions.set(version, aggregate);
    const classification = classifyConnectorVersion(connector.connector_version);
    if (classification === "beta55_or_earlier") {
      beta55OrEarlierUsers.add(connector.user_id);
    }
    if (classification === "beta55_or_earlier" || classification === "beta56") {
      preBeta57Users.add(connector.user_id);
      if (new Date(lastSeenAt) >= observationStart) {
        recentPreBeta57Users.add(connector.user_id);
      }
    }
    if (classification === "unknown") unknownConnectorUsers.add(connector.user_id);
  }

  const grantBindings = new Map<string, { grants: number; users: Set<string> }>();
  const legacyGrantUsers = new Set<string>();
  const recoveryV2GrantUsers = new Set<string>();
  const unknownGrantUsers = new Set<string>();
  for (const grant of grants.rows) {
    const bindingVersion = applicationBindingVersion(grant.application_authorization);
    const label = bindingVersion === null ? "unknown" : String(bindingVersion);
    const aggregate = grantBindings.get(label) ?? {
      grants: 0,
      users: new Set<string>()
    };
    aggregate.grants += 1;
    aggregate.users.add(grant.user_id);
    grantBindings.set(label, aggregate);
    if (bindingVersion === 4) legacyGrantUsers.add(grant.user_id);
    if (applicationRecoveryVersions(grant.application_authorization).includes(2)) {
      recoveryV2GrantUsers.add(grant.user_id);
    }
    if (bindingVersion !== 4 && bindingVersion !== 5) unknownGrantUsers.add(grant.user_id);
  }

  const telemetrySummary = [...aggregates.values()]
    .sort((left, right) =>
      left.surface.localeCompare(right.surface)
      || left.protocol_version - right.protocol_version
    )
    .map((entry) => ({
      surface: entry.surface,
      protocol_axis: "operation_transport",
      protocol_version: entry.protocol_version,
      samples: entry.samples,
      users: entry.users.size,
      first_seen_at: entry.first_seen_at,
      last_seen_at: entry.last_seen_at
    }));
  const recentV2 = telemetrySummary.filter((entry) => entry.protocol_version === 2);
  const observationStartedAt = migration.rows[0]
    ? isoTimestamp(migration.rows[0].applied_at)
    : null;
  const observationComplete = observationStartedAt !== null
    && new Date(observationStartedAt) <= observationStart;
  const providerTelemetryAvailable = providerReport !== null || hostedCollectionCount === 0;
  const unboundHostedReplicas = providerReport?.unbound_application_replicas ?? null;
  const hostedV2RecoveryReplicas =
    providerReport?.v2_recovery_application_replicas ?? null;
  const gates = [
    {
      name: "observation_window_complete",
      pass: observationComplete,
      value: observationStartedAt
    },
    {
      name: "no_recent_v2_usage",
      pass: recentV2.every((entry) => entry.samples === 0),
      value: recentV2.reduce((sum, entry) => sum + entry.samples, 0)
    },
    {
      name: "no_active_pre_beta57_connectors",
      pass: preBeta57Users.size === 0 && unknownConnectorUsers.size === 0,
      value: preBeta57Users.size + unknownConnectorUsers.size
    },
    {
      name: "no_active_v4_or_unknown_grants",
      pass: legacyGrantUsers.size === 0 && unknownGrantUsers.size === 0,
      value: legacyGrantUsers.size + unknownGrantUsers.size
    },
    {
      name: "no_active_v2_recovery_grants",
      pass: recoveryV2GrantUsers.size === 0,
      value: recoveryV2GrantUsers.size
    },
    {
      name: "hosted_provider_telemetry_available",
      pass: providerTelemetryAvailable,
      value: providerTelemetryAvailable
    },
    {
      name: "no_unmapped_hosted_usage_accounts",
      pass: unmappedHostedAccounts.size === 0,
      value: unmappedHostedAccounts.size
    },
    {
      name: "no_unbound_hosted_application_replicas",
      pass: unboundHostedReplicas === 0,
      value: unboundHostedReplicas
    },
    {
      name: "no_v2_recovery_hosted_application_replicas",
      pass: hostedV2RecoveryReplicas === 0,
      value: hostedV2RecoveryReplicas
    }
  ];

  return {
    generated_at: generatedAt.toISOString(),
    observation_window: {
      days: windowDays,
      starts_at: observationStart.toISOString(),
      telemetry_installed_at: observationStartedAt,
      complete: observationComplete
    },
    telemetry: telemetrySummary,
    connectors: {
      active_credentials: connectors.rows.length,
      versions: [...connectorVersions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([version, aggregate]) => ({
          version,
          connectors: aggregate.connectors,
          users: aggregate.users.size,
          last_seen_at: aggregate.last_seen_at
        })),
      beta55_or_earlier_users: beta55OrEarlierUsers.size,
      pre_beta57_users: preBeta57Users.size,
      recently_seen_pre_beta57_users: recentPreBeta57Users.size,
      unknown_version_users: unknownConnectorUsers.size
    },
    grants: {
      active: grants.rows.length,
      binding_versions: [...grantBindings.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([version, aggregate]) => ({
          version,
          grants: aggregate.grants,
          users: aggregate.users.size
        })),
      legacy_v4_users: legacyGrantUsers.size,
      recovery_v2_users: recoveryV2GrantUsers.size,
      unknown_binding_users: unknownGrantUsers.size
    },
    hosted: {
      collections: hostedCollectionCount,
      provider_telemetry_available: providerTelemetryAvailable,
      unbound_application_replicas: unboundHostedReplicas,
      v2_recovery_application_replicas: hostedV2RecoveryReplicas,
      unmapped_usage_accounts: unmappedHostedAccounts.size
    },
    sunset_gates: gates,
    ready_to_remove_compatibility: gates.every((gate) => gate.pass)
  };
}

function addProtocolAggregate(
  aggregates: Map<string, ProtocolAggregate>,
  input: {
    surface: ProtocolAggregate["surface"];
    protocolVersion: number;
    samples: number;
    userId?: string;
    firstSeenAt: string;
    lastSeenAt: string;
  }
): void {
  if (!Number.isInteger(input.protocolVersion) || input.protocolVersion <= 0) {
    throw new Error("Stored protocol telemetry has an invalid version.");
  }
  const key = `${input.surface}:${input.protocolVersion}`;
  const aggregate = aggregates.get(key) ?? {
    surface: input.surface,
    protocol_version: input.protocolVersion,
    samples: 0,
    users: new Set<string>(),
    first_seen_at: input.firstSeenAt,
    last_seen_at: input.lastSeenAt
  };
  aggregate.samples += input.samples;
  if (!Number.isSafeInteger(aggregate.samples)) {
    throw new Error("Protocol telemetry sample count exceeds the safe reporting range.");
  }
  if (input.userId) aggregate.users.add(input.userId);
  if (input.firstSeenAt < aggregate.first_seen_at) {
    aggregate.first_seen_at = input.firstSeenAt;
  }
  if (input.lastSeenAt > aggregate.last_seen_at) {
    aggregate.last_seen_at = input.lastSeenAt;
  }
  aggregates.set(key, aggregate);
}

function applicationBindingVersion(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const binding = (value as { binding?: unknown }).binding;
  if (!binding || typeof binding !== "object") return null;
  const protocolVersion = (binding as { protocol_version?: unknown }).protocol_version;
  return Number.isInteger(protocolVersion) ? protocolVersion as number : null;
}

function applicationRecoveryVersions(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const binding = (value as { binding?: unknown }).binding;
  if (!binding || typeof binding !== "object") return [];
  const contracts = (binding as { contracts?: unknown }).contracts;
  if (!contracts || typeof contracts !== "object") return [];
  const recovery = (contracts as {
    operation_transport_recovery?: unknown;
  }).operation_transport_recovery;
  return Array.isArray(recovery)
    ? recovery.filter((version): version is number => Number.isInteger(version))
    : [];
}

function classifyConnectorVersion(
  value: string | null
): "beta55_or_earlier" | "beta56" | "current" | "unknown" {
  if (!value) return "unknown";
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(value);
  if (!match) return "unknown";
  const release = match.slice(1, 4).map(Number) as [number, number, number];
  const target: [number, number, number] = [0, 1, 0];
  for (let index = 0; index < target.length; index += 1) {
    if (release[index] > target[index]) return "current";
    if (release[index] < target[index]) return "beta55_or_earlier";
  }
  if (match[4] === undefined) return "current";
  const beta = Number(match[4]);
  if (beta <= 55) return "beta55_or_earlier";
  if (beta === 56) return "beta56";
  return beta >= 57 ? "current" : "unknown";
}

function safeCount(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the safe reporting range.`);
  }
  return parsed;
}

function isoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Stored compatibility telemetry has an invalid timestamp.");
  }
  return timestamp.toISOString();
}


