import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { LogServiceClient } from "./log-service-client.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";
import { decodeCbor, encodeCbor, uuidBytes } from "./policy-wire.js";
import { activatePendingServices } from "./service-activation.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { parseLabPitrConfig, pitrCollection, pitrDeployments, pitrLogUrl, validatePitrCollections } from "./lab-pitr-config.js";

const config = {
  run: "gate4-pitr-lab-20261009-01", active: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  deleted: "dddddddd-dddd-4ddd-addd-dddddddddddd", owner: "11111111-1111-4111-a111-111111111111", createdAfter: 1,
  logUrl: "https://mdbase-next-log-pitr-lab-20261009-01.synthetic-test.workers.dev",
  hostedUrl: "https://mdbase-next-hosted-pitr-lab-20261009-01.synthetic-test.workers.dev"
}; // Nonoperational routing fixtures; fetch is always replaced in tests.
const env = (value: unknown = config) => ({ MDBASE_CONNECT_ENVIRONMENT: "lab", PUBLIC_URL: "https://connect-lab.mdbase.dev", MDBASE_NEXT_LAB_PITR: JSON.stringify(value) });

describe("fixed LAB PITR routing configuration", () => {
  it("is absent unless explicitly configured", () => expect(parseLabPitrConfig({})).toBeUndefined());
  it("never silently maps an old/shared row into the run", async () => {
    const p = parseLabPitrConfig(env())!;
    let calls = 0;
    const query = async (sql, values) => {
      calls++; expect(sql).toContain("created_at<to_timestamp");
      expect(values).toContain(p.createdAfter); expect(values).toContain(`[test] ${p.run} ACTIVE`);
      return { rows: [{ one: 1 }] };
    };
    await expect(validatePitrCollections({ query }, p)).rejects.toThrow("invalid_lab_pitr_configuration");
    await validatePitrCollections({ query }, undefined); expect(calls).toBe(1);
    await expect(validatePitrCollections({ query: async () => ({ rows: [] }) }, p)).resolves.toBeUndefined();
  });
  it("refuses a configured run while the real next control plane is disabled", () => {
    expect(() => parseNextControlPlaneEnv(env())).toThrow("LAB PITR requires the real next control plane.");
  });
  it("detaches and freezes the accepted mapping", () => {
    const p = parseLabPitrConfig(env())!;
    expect(p).toEqual(config); expect(Object.isFrozen(p)).toBe(true);
  });
  it.each(["production", "staging", "", undefined])("refuses environment %s", environment => {
    expect(() => parseLabPitrConfig({ ...env(), MDBASE_CONNECT_ENVIRONMENT: environment })).toThrow("invalid_lab_pitr_configuration");
  });
  it.each(["https://connect.mdbase.dev", "http://connect-lab.mdbase.dev", "https://connect-lab.mdbase.dev/", undefined])("refuses CP origin %s", publicUrl => {
    expect(() => parseLabPitrConfig({ ...env(), PUBLIC_URL: publicUrl })).toThrow();
  });
  it.each([null, [], {}, { ...config, run: "other" }, { ...config, extra: true }, { ...config, active: config.deleted },
    { ...config, active: "00000000-0000-0000-0000-000000000000" }, { ...config, owner: 1 },
    { ...config, deleted: config.deleted.toUpperCase() }, { ...config, owner: "not-a-uuid" },
    { ...config, createdAfter: 0 }, { ...config, createdAfter: 1.5 }, { ...config, createdAfter: "1" }])("refuses malformed mapping %#", value => {
    expect(() => parseLabPitrConfig(env(value))).toThrow();
  });
  it.each(["http://mdbase-next-log-pitr-lab-20261009-01.synthetic-test.workers.dev", `${config.logUrl}/`, `${config.logUrl}/v1`,
    `${config.logUrl}?x=1`, `${config.logUrl}#x`, config.logUrl.replace("https://", "https://user@"),
    config.logUrl.replace(".workers.dev", ".workers.dev.evil.test"), config.hostedUrl,
    config.logUrl.replace("synthetic-test", "different-account")])("refuses log origin %s", logUrl => {
    expect(() => parseLabPitrConfig(env({ ...config, logUrl }))).toThrow();
  });
  it("refuses oversized or invalid JSON", () => {
    for (const text of ["{", " ".repeat(2049)]) expect(() => parseLabPitrConfig({ ...env(), MDBASE_NEXT_LAB_PITR: text })).toThrow();
  });
  it("routes only the original two UUIDs, including case-equivalent representation", () => {
    const p = parseLabPitrConfig(env())!;
    for (const id of [p.active, p.deleted, p.active.toUpperCase()]) {
      expect(pitrCollection(p, id)).toBe(true); expect(pitrLogUrl("normal", p, id)).toBe(p.logUrl);
    }
    for (const id of [p.owner, "00000000-0000-0000-0000-000000000000"]) {
      expect(pitrCollection(p, id)).toBe(false); expect(pitrLogUrl("normal", p, id)).toBe("normal");
    }
  });
  it("preserves real role-specific tokens and normal deployment mappings", () => {
    const p = parseLabPitrConfig(env())!;
    const normal = { hosted: { url: "https://hosted.example.test", token: "synthetic-hosted" }, escrow: { url: "https://escrow.example.test", token: "synthetic-escrow" } };
    const target = pitrDeployments(normal, p, p.active);
    expect(target.hosted).toEqual({ url: p.hostedUrl, token: normal.hosted.token });
    expect(target.escrow).toEqual({ url: `${p.hostedUrl}/pitr-escrow`, token: normal.escrow.token });
    expect(pitrDeployments(normal, p, p.owner)).toBe(normal);
    expect(pitrDeployments(normal, undefined, p.active)).toBe(normal);
    expect(normal.escrow.url).toBe("https://escrow.example.test");
  });
  it.each([config.active, config.deleted, config.owner])("binds nonce and RPC to one collection-selected origin %s", async id => {
    const p = parseLabPitrConfig(env())!;
    const key = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(String(input));
      if (init?.method === "GET") return new Response("07".repeat(32));
      const frame = decodeCbor(Buffer.from(init!.body as Buffer)) as Map<number, unknown>;
      return new Response(encodeCbor({ struct: [[0, 1], [1, frame.get(1) as number], [3, { struct: [[0, "not_found"]] }]] }), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
    };
    const client = new LogServiceClient({ url: "https://normal.example.test", tokenIssuerKeyPem: key, transportKeyPem: key, labPitr: p }, fetcher);
    await expect(client.head(id)).rejects.toMatchObject({ code: "not_found" });
    const base = pitrCollection(p, id) ? p.logUrl : "https://normal.example.test";
    expect(urls).toEqual([`${base}/v1/nonce`, `${base}/v1/rpc`]);
    urls.length = 0;
    await expect(client.recordCollectionDeletion({ collection: id, deletionId: config.owner, lifecycleEpoch: 1n })).rejects.toMatchObject({ code: "not_found" });
    expect(urls).toEqual([`${base}/v1/nonce`, `${base}/v1/rpc`]);
  });
  it("keeps shared nil scans unchanged and pins isolated nil scans to the fixed run", async () => {
    const p = parseLabPitrConfig(env())!;
    const key = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const urls: string[] = [];
    let collection = p.deleted;
    const fetcher: typeof fetch = async (input, init) => {
      urls.push(String(input));
      if (init?.method === "GET") return new Response("07".repeat(32));
      const frame = decodeCbor(Buffer.from(init!.body as Buffer)) as Map<number, unknown>;
      expect(frame.get(2)).toBe("registry_collection_deletions");
      expect((frame.get(3) as Map<number, Uint8Array>).get(0)).toEqual(new Uint8Array(16));
      return new Response(encodeCbor({ struct: [[0,1],[1,frame.get(1) as number],[2,{struct:[
        [0,1],[1,7],[2,[[uuidBytes(collection),uuidBytes(p.owner),1]]],[3,uuidBytes(collection)],[4,true]
      ]}]] }));
    };
    const cfg = { url: "https://normal.example.test", tokenIssuerKeyPem: key, transportKeyPem: key, labPitr: p };
    const client = new LogServiceClient(cfg,fetcher);
    await client.registryCollectionDeletions();
    expect(urls.splice(0)).toEqual([`${cfg.url}/v1/nonce`,`${cfg.url}/v1/rpc`]);
    const page = await client.labPitrCollectionDeletions(p.run);
    expect(page).toMatchObject({generation:7n,rows:[{collection:p.deleted}],done:true});
    expect(urls.splice(0)).toEqual([`${p.logUrl}/v1/nonce`,`${p.logUrl}/v1/rpc`]);
    await expect(client.labPitrCollectionDeletions("other")).rejects.toThrow("configuration_required");
    await expect(client.labPitrCollectionDeletions(p.run,p.owner,7n)).rejects.toThrow("configuration_required");
    await expect(new LogServiceClient({...cfg,labPitr:undefined},fetcher).labPitrCollectionDeletions(p.run)).rejects.toThrow("configuration_required");
    expect(urls).toEqual([]);
    collection = p.owner;
    await expect(client.labPitrCollectionDeletions(p.run)).rejects.toMatchObject({code:"unavailable"});
    expect(urls).toEqual([`${p.logUrl}/v1/nonce`,`${p.logUrl}/v1/rpc`]);
  });
  it("excludes escrow before the activation query limit, without an ACK or wake", async () => {
    const p = parseLabPitrConfig(env())!;
    const rows = [
      { collection_id: p.active, kind: "escrow", batch_id: "1" },
      { collection_id: p.active, kind: "hosted", batch_id: "1" },
      { collection_id: p.owner, kind: "escrow", batch_id: "1" }
    ];
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? rows : [] }));
    const urls: string[] = [];
    const fetcher: typeof fetch = async input => { urls.push(String(input)); return Response.json({ activated: true }); };
    const deployments = { hosted: { url: "https://normal-hosted.example.test", token: "h".repeat(32) }, escrow: { url: "https://normal-escrow.example.test", token: "e".repeat(32) } };
    await activatePendingServices({ query } as unknown as DatabaseQueryable, deployments, fetcher, undefined, p);
    expect(query.mock.calls[0][0]).toContain("AND NOT (device.kind = 'escrow' AND device.collection_id = ANY($2::uuid[]))");
    expect(urls.sort()).toEqual([`${p.hostedUrl}/internal/v1/collections/activate`, "https://normal-escrow.example.test/internal/v1/collections/activate"].sort());
    expect(query.mock.calls.length).toBe(3); // SELECT, hosted ACK, unrelated escrow ACK only.
  });
});
