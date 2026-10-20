import { describe, expect, it, vi } from "vitest";
// Tests the actual helpers/creator client with only the compiled build literal substituted.
vi.mock("../../local-build.js", () => ({ LOCAL_REHEARSAL_BUILD: true }));
import { localDeployment } from "../../local-deployment.js";
import { labTargetBootstrap, migrationJobEnvironment } from "./migration-lab-target.js";
import { labWorkerClient, postgresLabConnect } from "./migration-lab.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";
import { configuredClaimAudience } from "./migration-claim-auth.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { installationApp } from "../connectors/installation-pairing.js";

const account = "10000000-0000-4000-8000-000000000001", collection = "20000000-0000-4000-8000-000000000002";
const origin = "http://127.0.0.1:8111", token = "t".repeat(40);
const metadata = { collection_id: collection, owner_account: account, state: "cloud-copy", service_devices: [
  { kind: "hosted", device_id: "30000000-0000-4000-8000-000000000003" },
  { kind: "escrow", device_id: "40000000-0000-4000-8000-000000000004" }
] };
const env = { MDBASE_CONNECT_ENVIRONMENT: "local", PUBLIC_URL: origin, MDBASE_NEXT_CONTROL_PLANE: "1",
  MDBASE_NEXT_ROOT_PUBLIC_KEY: "aa".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "parsed separately", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
  MDBASE_NEXT_LOG_SERVICE_URL: "http://127.0.0.1:8222", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "parsed separately", MDBASE_NEXT_LOG_TRANSPORT_KEY: "parsed separately",
  MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "1", MDBASE_NEXT_HOSTED_SERVICE_URL: "http://127.0.0.1:8333", MDBASE_NEXT_ESCROW_SERVICE_URL: "http://127.0.0.1:8444",
  MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: "h".repeat(40), MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: "e".repeat(40),
  MDBASE_NEXT_HOSTED_SERVICE_TOKEN: "H".repeat(40), MDBASE_NEXT_ESCROW_SERVICE_TOKEN: "E".repeat(40) };

describe("explicit local build transport scope", () => {
  it("accepts exact loopback only in local, not another environment", () => {
    expect(localDeployment("local", origin)).toBe(true);
    expect(configuredClaimAudience(origin)).toBe(origin);
    expect(() => configuredClaimAudience("https://connect-lab.mdbase.dev")).toThrow();
    for (const environment of ["lab", "staging", "production", undefined]) expect(localDeployment(environment, origin)).toBe(false);
    for (const value of ["http://localhost:8111", "http://127.1:8111", origin + "/", origin + "?x", "http://user@127.0.0.1:8111", "https://connect-lab.mdbase.dev"]) expect(localDeployment("local", value)).toBe(false);
  });
  it("admits only an exact registered local installation origin on a local server", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: account, name: "Local Notes", family_identity: "bundle:local.notes",
      installation_origins: { local: { "app-runtime": [origin] } },
      requirements: { access: "full_collection", contracts: [] }, notifications: { criteria: [] } }] }));
    const db = { query } as unknown as DatabaseQueryable;
    expect(await installationApp(db, "local", account, origin, "app-runtime")).toEqual({ id: account, origin, name: "Local Notes" });
    for (const environment of ["lab", "staging", "production"]) {
      await expect(installationApp(db, environment, account, origin, "app-runtime"))
        .rejects.toMatchObject({ status: 403, code: "installation_app_not_allowed" });
    }
    for (const value of ["http://localhost:8111", "http://127.0.0.1:8112", origin + "/", "https://remote.example.test"]) {
      await expect(installationApp(db, "local", account, value, "app-runtime"))
        .rejects.toMatchObject({ status: 403, code: "installation_app_not_allowed" });
    }
  });
  it("calls the SAME canonical target with the SAME authenticated request and metadata checks", async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(origin + `/internal/v1/next/migration/collections/${collection}/target`);
      expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", headers: { authorization: `Bearer ${token}` } });
      return Response.json(metadata);
    });
    await labTargetBootstrap({ environment: "local", url: origin, token, account }, transport)(collection);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(labTargetBootstrap({ environment: "local", url: origin, token, account }, async () => Response.json({ ...metadata, owner_account: collection }))(collection)).rejects.toMatchObject({ code: "migration_target_unavailable" });
  });
  it("refuses managed environment/config before any target or Worker transport", () => {
    const transport = vi.fn<typeof fetch>();
    for (const environment of ["lab", "staging", "production", undefined]) {
      expect(() => labTargetBootstrap({ environment, url: origin, token, account }, transport)).toThrow();
      expect(() => labWorkerClient({ environment, url: origin, token }, transport)).toThrow();
      expect(() => parseNextControlPlaneEnv({ ...env, MDBASE_CONNECT_ENVIRONMENT: environment })).toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
    expect(() => labTargetBootstrap({ environment: "lab", url: "https://connect-lab.mdbase.dev", token, account }, transport)).toThrow();
  });
  it("never composes a managed migration port in a local build", () => {
    const query = vi.fn();
    const db = { query } as unknown as Parameters<typeof postgresLabConnect>[0]["db"];
    for (const environment of ["lab", "staging", "production", undefined]) {
      expect(migrationJobEnvironment(environment)).toBeUndefined();
      expect(() => postgresLabConnect({ db, source: db, actor: "test", timers: true, environment,
        provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"] })).toThrow(expect.objectContaining({ code: "lab_only" }));
    }
    expect(() => postgresLabConnect({ db, source: db, actor: "test", timers: true, environment: "local",
      provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"] })).not.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("local factory URLs require local build and exact local origin; token separation is unchanged", () => {
    expect(parseNextControlPlaneEnv(env)?.cloudCopyBootstrap?.hosted.url).toBe(env.MDBASE_NEXT_HOSTED_SERVICE_URL);
    for (const value of ["http://localhost:8333", "http://external.test:8333", "https://hosted.example.test", "http://127.0.0.1:8333/path"]) {
      expect(() => parseNextControlPlaneEnv({ ...env, MDBASE_NEXT_HOSTED_SERVICE_URL: value })).toThrow();
    }
    expect(() => parseNextControlPlaneEnv({ ...env, MDBASE_NEXT_HOSTED_SERVICE_TOKEN: env.MDBASE_NEXT_HOSTED_INTERNAL_TOKEN })).toThrow();
  });
});
