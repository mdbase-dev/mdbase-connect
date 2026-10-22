import { describe, expect, it } from "vitest";
import pg from "pg";
import { postgresPoolConfig } from "../../db.js";
import { labLegacySourceConnection } from "./migration-lab-source-tls.js";

const host = "dpg-dabpdaon74is7380br1g-a";
const database = "mdbase_lab_beta94_202609020323211110102";
const role = "mdbn_lab_migration_cli_reader";
const readonlyOptions = "options=-cdefault_transaction_read_only%3Don";
const uri = (query = `sslmode=require&${readonlyOptions}`) =>
  `postgresql://${role}:synthetic@${host}:5432/${database}?${query}`;
const refused = /migration_lab_source_tls_.*refused/u;

function parameters(config: ReturnType<typeof labLegacySourceConnection>) {
  // The genuine pg parser must retain explicit TLS and PostgreSQL read-only
  // options. Constructor only: no connection, credentials or live endpoint.
  return (new pg.Client(postgresPoolConfig(config.url, config.ssl)) as unknown as {
    connectionParameters: { ssl: typeof config.ssl; options: string }
  }).connectionParameters;
}

describe("LAB internal legacy source encrypted TLS", () => {
  it.each([host, `${host}.own-d9fbuuv41pts73dspdcg.svc.cluster.local`])(
    "requires encrypted, unpinned TLS for the scoped internal host %s", (hostname) => {
      const config = labLegacySourceConnection(uri().replace(host, hostname), "lab");
      expect(config.ssl).toEqual({ rejectUnauthorized: false });
      expect(new URL(config.url).searchParams.has("sslmode")).toBe(false);
      expect(new URL(config.url).searchParams.has("sslrootcert")).toBe(false);
      expect(parameters(config).ssl).toEqual({ rejectUnauthorized: false });
      expect(parameters(config).options).toBe("-cdefault_transaction_read_only=on");
    }
  );
  it.each([
    readonlyOptions,
    `sslmode=verify-ca&sslrootcert=%2Fnonexistent%2Fprevious-cert.pem&${readonlyOptions}`,
    `sslmode=disable&${readonlyOptions}`
  ])("forces TLS without reading or depending on URL certificate material: %s", (query) => {
    const config = labLegacySourceConnection(uri(query), "lab");
    expect(parameters(config).ssl).toEqual({ rejectUnauthorized: false });
    expect(new URL(config.url).searchParams.has("sslmode")).toBe(false);
    expect(new URL(config.url).searchParams.has("sslrootcert")).toBe(false);
  });
  it.each([
    uri().replace(`/${database}`, "/other_database"),
    uri().replace(role, "owner_role"), uri().replace(":5432", ":5433"), uri().replace(":5432", ""),
    uri().replace(":synthetic@", ":@"), uri().replace("postgresql:", "https:"),
    uri() + "&host=other.invalid", uri() + "&ssl=false", uri() + "&uselibpqcompat=true", uri() + "#fragment"
  ])("retains internal host/database/role/override checks", (value) => {
    expect(() => labLegacySourceConnection(value, "lab")).toThrow(refused);
  });
});

describe("LAB rehearsal owner-readonly exception", () => {
  const owner = "synthetic_lab_owner";
  const ownerUri = () => uri().replace(role, owner);
  it("requires explicit owner identity and retains PostgreSQL read-only options", () => {
    expect(() => labLegacySourceConnection(ownerUri(), "lab")).toThrow(refused);
    const config = labLegacySourceConnection(ownerUri(), "lab", owner);
    expect(parameters(config).options).toBe("-cdefault_transaction_read_only=on");
    expect(parameters(config).ssl).toEqual({ rejectUnauthorized: false });
  });
  it.each([
    [ownerUri(), "staging", owner], [ownerUri(), "production", owner],
    [ownerUri(), "lab", ""], [ownerUri(), "lab", "other_owner"], [ownerUri(), "lab", role],
    [ownerUri().replace(/&options=[^&]+/u, ""), "lab", owner],
    [ownerUri().replace("read_only%3Don", "read_only%3Doff"), "lab", owner],
    [ownerUri() + `&${readonlyOptions}`, "lab", owner],
    [ownerUri().replace(host, "external.invalid"), "lab", owner],
    [ownerUri().replace(":5432", ""), "lab", owner]
  ])("retains owner identity/scope/read-only checks", (value, environment, ownerRole) => {
    expect(() => labLegacySourceConnection(value!, environment, ownerRole)).toThrow(refused);
  });
});

describe("non-LAB TLS policy is unchanged", () => {
  it.each(["staging", "production", undefined])("does not enable the internal exception in %s", (environment) => {
    expect(() => labLegacySourceConnection(uri(), environment)).toThrow(refused);
  });
  it.each(["lab", "staging", "production", undefined])("leaves ordinary public/control URLs untouched in %s", (environment) => {
    const publicUrl = "postgres://synthetic:synthetic@external.invalid/control?sslmode=verify-full";
    const config = labLegacySourceConnection(publicUrl, environment);
    expect(config).toEqual({ url: publicUrl });
    expect(postgresPoolConfig(config.url)).not.toHaveProperty("ssl");
    expect(parameters(config).ssl?.rejectUnauthorized).not.toBe(false);
    expect(new URL(config.url).searchParams.get("sslmode")).toBe("verify-full");
  });
});
