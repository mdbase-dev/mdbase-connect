// Migration runner composition of the existing authenticated SHADOW target creator.
// No new bootstrap, custody exemption, target selector, serving or H1 authority.
import { z } from "zod";
import { localBuild, localDeployment, rehearsalDiagnostics } from "../../local-deployment.js";
import { migrationUuid } from "../../hosted-provider-replies.js";
import { RolloutRefused } from "./migration-rollout.js";

// Only finite labels/paths are retained, never URLs, credentials, body values or
// arbitrary exception messages/stacks. Error identity and public refusal stay put.
type TargetCause = {
  call: "guard" | "fetch" | "http" | "body" | "json" | "schema" | "identity";
  guard?: "origin" | "token" | "account" | "collection" | "composition";
  name?: "Error" | "TypeError" | "RangeError" | "AbortError" | "TimeoutError" | "SyntaxError" | "other";
  http_status?: number;
  api_error_code?: string;
  network_code?: string;
  zod_path?: (string | number)[];
  field?: "collection_id" | "owner_account" | "service_devices";
  reason?: "empty" | "over_bound" | "invalid";
};
const causes = new WeakMap<object, TargetCause>();
export function labTargetUnavailable(environment: string | undefined, cause: TargetCause): never {
  const error = new RolloutRefused("migration_target_unavailable", "No verified SHADOW custody target; Worker run not dispatched.", 503);
  if (rehearsalDiagnostics(environment)) causes.set(error, cause);
  throw error;
}
export function labTargetSubCause(error: unknown, environment: string | undefined) {
  return rehearsalDiagnostics(environment) && error instanceof Error ? causes.get(error) : undefined;
}
const names = z.enum(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "SyntaxError", "other"]).catch("other");
const apiCodes = z.enum(["invalid_internal_token", "invalid_request", "migration_target_unavailable", "migration_source_unavailable",
  "migration_source_not_current", "migration_source_changed", "migration_subject_not_current", "collection_not_standard",
  "collection_not_current", "collection_already_exists", "service_devices_unavailable", "collection_exists", "collection_deleted",
  "not_current_cloud_copy", "not_current_collection", "not_ready", "device_revoked", "not_member", "not_owner", "not_enrolled",
  "lab_pitr_fixture_required", "invalid_proof", "identity_not_current", "wrong_service_scope", "busy", "internal_error", "unknown"]);
const networkCodes = z.enum(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "unknown"]);
const pathFields = new Set(["collection_id", "owner_account", "state", "service_devices", "kind", "device_id"]);
const metadata = z.object({
  collection_id: migrationUuid, owner_account: migrationUuid, state: z.literal("cloud-copy"),
  service_devices: z.array(z.object({ kind: z.enum(["hosted", "escrow"]), device_id: migrationUuid }).passthrough()).length(2)
}).passthrough();

// Reviewed CP identities, not caller-selected origins. Worker/publication and
// custody qualification remain the ordinary deployment's independent gates.
const MIGRATION_ORIGINS = {
  lab: "https://connect-lab.mdbase.dev/", staging: "https://connect-staging.mdbase.dev/", production: "https://connect.mdbase.dev/"
} as const;
type MigrationJobEnvironment = keyof typeof MIGRATION_ORIGINS;

/** The deployment's own environment (server configuration, never a caller
 * flag). Unknown labels and managed environments in local builds fail closed. */
export function migrationJobEnvironment(environment: string | undefined): MigrationJobEnvironment | undefined {
  return !localBuild() && (environment === "lab" || environment === "staging" || environment === "production") ? environment : undefined;
}

/** Deployment-owned job selection; callers cannot opt into the fixture contract. */
export function migrationJobForEnvironment(environment: string | undefined): "lab" | "managed" | undefined {
  if (localBuild()) return environment === "local" ? "lab" : undefined;
  const admitted = migrationJobEnvironment(environment);
  return admitted === "lab" ? "lab" : admitted ? "managed" : undefined;
}

/** Pure target admission, also run by the CLI before opening either database,
 * including resume/status invocations which do not create a fresh target. */
export function requireMigrationTargetOrigin(environment: string | undefined, url: string): URL {
  let origin: URL;
  try { origin = new URL(url); } catch { return labTargetUnavailable(environment, { call: "guard", guard: "origin" }); }
  const job = migrationJobEnvironment(environment);
  if (localBuild() ? !localDeployment(environment, url) : !job || origin.href !== MIGRATION_ORIGINS[job])
    return labTargetUnavailable(environment, { call: "guard", guard: "origin" });
  return origin;
}

export function labTargetBootstrap(config: { environment?: string; url: string; token: string; account: string }, fetchImpl: typeof fetch = fetch) {
  if (localBuild() ? !localDeployment(config.environment, config.url) : !migrationJobEnvironment(config.environment))
    throw new RolloutRefused("lab_only", "Migration target bootstrap is unavailable in this build/environment.", 503);
  const unavailable = (cause: TargetCause): never => labTargetUnavailable(config.environment, cause);
  // Guard failures are part of the same prepare_target stop/capture as HTTP
  // failures, not an opaque top-level exit before orchestration can record them.
  return async (collection: string): Promise<void> => {
    const origin = requireMigrationTargetOrigin(config.environment, config.url);
    if (config.token.length < 32 || /[\r\n]/u.test(config.token)) return unavailable({ call: "guard", guard: "token" });
    if (!migrationUuid.safeParse(config.account).success) return unavailable({ call: "guard", guard: "account" });
    if (!migrationUuid.safeParse(collection).success) return unavailable({ call: "guard", guard: "collection" });
    let response: Response;
    try {
      response = await fetchImpl(new URL(`/internal/v1/next/migration/collections/${collection}/target`, origin), {
        method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: "{}", redirect: "error", signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      const network = z.object({ cause: z.object({ code: networkCodes.catch("unknown") }) }).safeParse(error);
      return unavailable({ call: "fetch", name: names.parse(error instanceof Error ? error.name : "other"),
        ...(network.success ? { network_code: network.data.cause.code } : {}) });
    }
    const http_status = response.status, reader = response.body?.getReader();
    if (!reader) return unavailable({ call: response.ok ? "body" : "http", http_status, reason: "empty" });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.length;
        if (bytes > 1024 * 1024) { await reader.cancel(); return unavailable({ call: "body", http_status, reason: "over_bound" }); }
        chunks.push(item.value);
      }
    } catch (error) {
      // Do not collapse an already-qualified bounded-body refusal into a read error.
      if (labTargetSubCause(error, config.environment)) throw error;
      return unavailable({ call: "body", http_status, name: names.parse(error instanceof Error ? error.name : "other") });
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return unavailable({ call: response.ok ? "json" : "http", http_status, reason: "invalid" }); }
    if (!response.ok) {
      const code = z.object({ error: z.object({ code: apiCodes.catch("unknown") }) }).safeParse(value);
      return unavailable({ call: "http", http_status, api_error_code: code.success ? code.data.error.code : "unknown" });
    }
    const result = metadata.safeParse(value);
    if (!result.success) return unavailable({ call: "schema", http_status,
      zod_path: result.error.issues[0]!.path.slice(0, 4).map(part => typeof part === "number" && part >= 0 && part <= 1 ? part : pathFields.has(String(part)) ? String(part) : "other") });
    if (result.data.collection_id !== collection) return unavailable({ call: "identity", http_status, field: "collection_id" });
    if (result.data.owner_account !== config.account) return unavailable({ call: "identity", http_status, field: "owner_account" });
    if (new Set(result.data.service_devices.map(device => device.kind)).size !== 2) return unavailable({ call: "identity", http_status, field: "service_devices" });
  };
}
