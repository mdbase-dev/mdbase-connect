// Hermetic canonical-helper composition checks; SQL substituted, no PG/provider.
import { describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../../database-types.js";
import { pitrLabel, type LabPitrConfig } from "./lab-pitr-config.js";
import { cloudCopyMetadata, createServiceCloudCopy, existingCloudCopy, type CloudCopyBootstrapOptions } from "./service-cloud-copy.js";
const A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", D = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const OTHER = "33333333-3333-4333-a333-333333333333", OWNER = "11111111-1111-4111-a111-111111111111";
const pitr: LabPitrConfig = { run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,owner:OWNER,createdAfter:1000,
  logUrl:"https://synthetic-log.example.test",hostedUrl:"https://synthetic-hosted.example.test" };
function fixture(change: object = {}) {
  const queries: string[] = [];
  const row = {owner_user_id:OWNER,sync:"cloud_copy",left:false,created_at:new Date(1000),display_name:pitrLabel(pitr,A),...change};
  const client = { async query(sql: string) { queries.push(sql); return {rows:sql.includes("FROM next_collections")?[row]:[]}; } } as unknown as DatabaseConnection;
  return {client,queries};
}
const options = {next:{rootPublicKey:Buffer.alloc(32,1),policyCert:{root_key_id:"06".repeat(16)},
  logService:{url:"https://normal.example.test",labPitr:pitr}}} as unknown as CloudCopyBootstrapOptions;
describe("canonical service creator explicit PITR subset", () => {
  it("keeps the ordinary lookup byte-identical without requiring fixture metadata", async () => {
    const f=fixture({created_at:undefined,display_name:undefined});
    expect(await existingCloudCopy(f.client,OTHER,OWNER)).toBe(true);
    expect(f.queries.at(-1)).toBe("SELECT owner_user_id, sync, left_sync_at IS NOT NULL AS left FROM next_collections WHERE collection_id = $1 FOR UPDATE");
  });
  it("does not widen PITR scope to another collection", async () => {
    const f=fixture({created_at:undefined,display_name:undefined});
    expect(await existingCloudCopy(f.client,OTHER,OWNER,pitr)).toBe(true);
    expect(f.queries.at(-1)).not.toContain("created_at");
  });
  it("accepts the exact run-owned existing fixture through the same helper", async () => {
    const f=fixture(); expect(await existingCloudCopy(f.client,A,OWNER,pitr)).toBe(true);
    expect(f.queries.at(-1)).toContain("created_at, display_name");
  });
  it.each([{created_at:new Date(999)},{created_at:undefined},{created_at:new Date(NaN)},
    {display_name:"not-this-run"},{owner_user_id:OTHER},{left:true},{sync:"local"}])("refuses a foreign/stale fixture %j", async change => {
    const f=fixture(change); await expect(existingCloudCopy(f.client,A,OWNER,pitr)).rejects.toMatchObject({code:"collection_exists"});
  });
  it.each([{runtime:"shadow" as const,owner:OWNER,displayName:pitrLabel(pitr,A)},
    {runtime:"next" as const,owner:OTHER,displayName:pitrLabel(pitr,A)},
    {runtime:"next" as const,owner:OWNER,displayName:"not-this-run"}])("refuses mismatched isolated creation before principal/SQL/service effects %j", async input => {
    let calls=0;
    await expect(createServiceCloudCopy(options,{collection:A,...input,current:async()=>{calls++;}}))
      .rejects.toMatchObject({code:"lab_pitr_fixture_required"});
    expect(calls).toBe(0); // options intentionally has no DB/emitter/network capability.
  });
  it("routes public metadata only for the exact fixed subset", () => {
    const metadata=(collection:string)=>cloudCopyMetadata(options,collection,OWNER,{seq:1,chain:Buffer.alloc(32)},Buffer.from([1]),[]);
    expect(metadata(A).log_url).toBe(pitr.logUrl); expect(metadata(D).log_url).toBe(pitr.logUrl);
    expect(metadata(OTHER).log_url).toBe("https://normal.example.test");
  });
});
