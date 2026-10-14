import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import pg from "pg";
import { postgresPoolConfig } from "../../db.js";
import { labLegacySourceConnection, LAB_LEGACY_SOURCE_CERT_SHA256 } from "./migration-lab-source-tls.js";

const host = "dpg-dabpdaon74is7380br1g-a";
const database = "mdbase_lab_beta94_202609020323211110102";
const role = "mdbn_lab_migration_cli_reader";
const rootPath = new URL("./fixtures/lab-legacy-postgres.pem", import.meta.url).pathname;
const actual = new X509Certificate(readFileSync(rootPath));
const uri = (ca = rootPath) => `postgresql://${role}:synthetic@${host}:5432/${database}?sslmode=verify-ca&sslrootcert=${encodeURIComponent(ca)}&options=-cdefault_transaction_read_only%3Don`;
const peer = (cert: X509Certificate) => ({ fingerprint256: cert.fingerprint256, raw: cert.raw, subject: { CN: cert.subject.slice(3) } }) as PeerCertificate;
let scratch: string, other: X509Certificate;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "lab-source-pin-test-"));
  // A real, different self-signed certificate with the SAME CN. No LAB key.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/${actual.subject}`, "-keyout", join(scratch, "key.pem"), "-out", join(scratch, "cert.pem")], { stdio: "ignore" });
  other = new X509Certificate(readFileSync(join(scratch, "cert.pem")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("exact LAB legacy source certificate pin", () => {
  it("pins the captured public DER and keeps CA verification enabled", () => {
    expect(actual.fingerprint256.replace(/:/gu, "")).toBe(LAB_LEGACY_SOURCE_CERT_SHA256);
    expect(actual.subject).toBe(actual.issuer); expect(actual.subjectAltName).toBeUndefined();
    const config = labLegacySourceConnection(uri(), "lab");
    expect(config.ssl?.rejectUnauthorized).toBe(true); expect(config.ssl?.ca).toBe(actual.toString());
    expect(config.ssl?.checkServerIdentity?.(host, peer(actual))).toBeUndefined();
    expect(new URL(config.url).searchParams.get("options")).toBe("-cdefault_transaction_read_only=on");
    expect(new URL(config.url).searchParams.has("sslmode")).toBe(false);
    expect(new URL(config.url).searchParams.has("sslrootcert")).toBe(false);
  });
  it("rejects a wrong fingerprint", () => {
    const check = labLegacySourceConnection(uri(), "lab").ssl!.checkServerIdentity!;
    expect(check(host, { ...peer(actual), fingerprint256: "00:".repeat(31) + "00" })).toBeInstanceOf(Error);
  });
  it("rejects a different real self-signed certificate with matching CN", () => {
    expect(other.subject).toBe(actual.subject); expect(other.fingerprint256).not.toBe(actual.fingerprint256);
    expect(labLegacySourceConnection(uri(), "lab").ssl!.checkServerIdentity!(host, peer(other))).toBeInstanceOf(Error);
    expect(() => labLegacySourceConnection(uri(join(scratch, "cert.pem")), "lab")).toThrow("migration_lab_source_tls_pin_refused");
  });
  it("rejects another hostname even with the pinned certificate", () => {
    expect(labLegacySourceConnection(uri(), "lab").ssl!.checkServerIdentity!("other.invalid", peer(actual))).toBeInstanceOf(Error);
  });
  it("retains the identity hook through the genuine pinned pg configuration parser", () => {
    const config = labLegacySourceConnection(uri(), "lab"), pool = postgresPoolConfig(config.url, config.ssl);
    const client = new pg.Client(pool); // Constructor only: no connect/query.
    const params = (client as unknown as { connectionParameters: { ssl: typeof config.ssl } }).connectionParameters;
    expect(params.ssl?.rejectUnauthorized).toBe(true); expect(params.ssl?.ca).toBe(actual.toString());
    expect(params.ssl?.checkServerIdentity).toBe(config.ssl?.checkServerIdentity);
    expect(params.ssl?.checkServerIdentity?.(host, peer(other))).toBeInstanceOf(Error);
  });
  it("keeps ordinary control/public/staging pool policy untouched", () => {
    const publicUrl = "postgres://synthetic:synthetic@external.invalid/control?sslmode=verify-full";
    expect(labLegacySourceConnection(publicUrl, "lab")).toEqual({ url: publicUrl });
    expect(postgresPoolConfig(publicUrl)).not.toHaveProperty("ssl");
    expect(() => labLegacySourceConnection(uri(), "staging")).toThrow("migration_lab_source_tls_pin_refused");
    expect(() => labLegacySourceConnection(uri(), "production")).toThrow("migration_lab_source_tls_pin_refused");
  });
  it.each([
    uri().replace(`/${database}`, "/other_database"),
    uri().replace(role, "owner_role"), uri().replace(":5432", ":5433"), uri().replace(":5432", ""),
    uri().replace("sslmode=verify-ca", "sslmode=require"),
    uri() + "&host=other.invalid", uri() + "&ssl=false", uri() + "&uselibpqcompat=true",
    uri() + "&sslrootcert=/other.pem", uri() + "#fragment",
    uri().replace(/&sslrootcert=[^&]+/u, "")
  ])("refuses a scope/TLS override without reading credentials", (value) => {
    expect(() => labLegacySourceConnection(value, "lab")).toThrow("migration_lab_source_tls_pin_refused");
  });
});
