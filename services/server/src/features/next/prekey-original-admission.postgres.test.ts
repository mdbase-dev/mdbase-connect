// Dedicated local PostgreSQL ONLY: actual migration, locks/unique registration,
// quota/floor/GC. No provider, native caller or managed clock qualification.
import {randomUUID,sign,verify} from "node:crypto";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import pg from "pg";
import {z} from "zod";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {NIL,lock,inTransaction} from "./bootstrap-common.js";
import {ed25519PublicKeyObject,verifyCert} from "./policy-keys.js";
import {decodeCbor,domainHash,encodeCbor,encodeCert,keyId,policyItemSignedDigest,uuidBytes} from "./policy-wire.js";
import type {DatabasePool} from "../../database-types.js";
const source=stripTypeScriptTypes(readFileSync(new URL("./lab-pitr-routes.ts",import.meta.url),"utf8"),{mode:"transform"})
  .replace(/^import[\s\S]*?;\n/gm,"").replace("export function registerLabPitrRoutes","function registerLabPitrRoutes");
const deps={z,NIL,sign,verify,decodeCbor,domainHash,encodeCbor,encodeCert,keyId,policyItemSignedDigest,uuidBytes,ed25519PublicKeyObject,verifyCert};
const {registerCpNonce,cpStatementNow,lockCpNonceOwner}=new Function(...Object.keys(deps),source+"\nreturn {registerCpNonce,cpStatementNow,lockCpNonceOwner};")(...Object.values(deps)) as {
  lockCpNonceOwner:(db:pg.PoolClient,owner:string)=>Promise<void>;
  registerCpNonce:(db:pg.PoolClient,col:string,owner:string,nonce:Buffer,transcript:Buffer,challenge:Buffer,now:number)=>Promise<boolean>;
  cpStatementNow:(db:pg.Pool|pg.PoolClient)=>Promise<number>;
};
const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL==="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const pgDescribe=testUrl&&approved?describe:describe.skip;
pgDescribe("pre-key v2 committed replay registration (real isolated PostgreSQL)",()=>{
  let admin:pg.Pool,db:pg.Pool,schema:string;
  beforeAll(async()=>{
    const url=new URL(testUrl!);if(!["localhost","127.0.0.1","::1"].includes(url.hostname)||!/test/i.test(url.pathname))throw Error("dedicated local test database required");
    schema="prekey_http_test_"+randomUUID().replaceAll("-","");admin=new pg.Pool({connectionString:url.toString(),max:2});await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options","-csearch_path="+schema);db=new pg.Pool({connectionString:url.toString(),max:8});
    await db.query(readFileSync(new URL("../../../migrations/0072_next_prekey_http_nonce_uses.sql",import.meta.url),"utf8"));
  });
  afterAll(async()=>{await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin?.end();});
  const nonce=(now:number,n=0)=>{const b=Buffer.alloc(32,0x36);b.writeBigUInt64BE(BigInt(now));b.writeUInt32BE(n,8);return b;};
  async function fixture(owner=randomUUID()){
    const col=randomUUID(),now=await cpStatementNow(db);
    await db.query("INSERT INTO next_prekey_http_nonce_floors VALUES($1,$2,$3,$4,$5)",[col,owner,now-100000,now-35000,now-1000]);
    return {col,owner,now};
  }
  const register=async(f:{col:string;owner:string},n:Buffer,t=Buffer.alloc(32,0x37),ch=Buffer.alloc(32,0x35))=>inTransaction(db as unknown as DatabasePool,async c=>{
    await lockCpNonceOwner(c as unknown as pg.PoolClient,f.owner);await lock(c,f.col);
    return registerCpNonce(c as unknown as pg.PoolClient,f.col,f.owner,n,t,ch,await cpStatementNow(c as unknown as pg.PoolClient));
  });
  it("reads authoritative time after queued locks, not an earlier BEGIN clock",async()=>{
    const f=await fixture(),a=await db.connect(),b=await db.connect();try{
      await a.query("BEGIN");const begin=Number((await a.query("SELECT floor(extract(epoch FROM now())*1000)::text AS begin_ms")).rows[0].begin_ms);
      await b.query("BEGIN");await lockCpNonceOwner(b,f.owner);await lock(b as unknown as Parameters<typeof lock>[0],f.col);
      const waiting=lockCpNonceOwner(a,f.owner);await b.query("SELECT pg_sleep(0.02)");
      const newer=await cpStatementNow(b);expect(newer).toBeGreaterThan(begin);
      expect(await registerCpNonce(b,f.col,f.owner,nonce(f.now,1),Buffer.alloc(32,1),Buffer.alloc(32,2),newer)).toBe(true);
      await b.query("COMMIT");await waiting;await lock(a as unknown as Parameters<typeof lock>[0],f.col);
      const authoritative=await cpStatementNow(a);expect(authoritative).toBeGreaterThanOrEqual(newer);
      expect(await registerCpNonce(a,f.col,f.owner,nonce(f.now,2),Buffer.alloc(32,1),Buffer.alloc(32,2),authoritative)).toBe(true);
      await a.query("COMMIT");expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows).toHaveLength(2);
    }finally{await b.query("ROLLBACK");await a.query("ROLLBACK");b.release();a.release();}
  });
  it("atomically admits exactly one across connections for same N and different T/challenge",async()=>{
    const f=await fixture(),n=nonce(f.now),results=await Promise.allSettled(Array.from({length:4},(_,i)=>register(f,n,Buffer.alloc(32,0x37+i),Buffer.alloc(32,0x35+i))));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(3);
    expect((await db.query("SELECT * FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows).toHaveLength(1);
    await expect(register(f,n)).rejects.toThrow("prekey_nonce_consumed");
  });
  it("rollback leaves no consumed nonce while simulated output loss after COMMIT never reissues",async()=>{
    const f=await fixture(),n=nonce(f.now);
    await expect(inTransaction(db as unknown as DatabasePool,async c=>{await lockCpNonceOwner(c as unknown as pg.PoolClient,f.owner);await lock(c,f.col);
      await registerCpNonce(c as unknown as pg.PoolClient,f.col,f.owner,n,Buffer.alloc(32,1),Buffer.alloc(32,2),await cpStatementNow(c as unknown as pg.PoolClient));throw Error("reject before commit");})).rejects.toThrow("reject before commit");
    expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows).toHaveLength(0);
    await register(f,n);await expect(register(f,n)).rejects.toThrow("prekey_nonce_consumed");
  });
  it("initializes and commits a persistent floor without admitting the first nonce",async()=>{
    const f={col:randomUUID(),owner:randomUUID()},now=await cpStatementNow(db);expect(await register(f,nonce(now))).toBe(false);
    const row=(await db.query("SELECT * FROM next_prekey_http_nonce_floors WHERE collection_id=$1",[f.col])).rows[0];expect(Number(row.not_before_ms)-Number(row.cutoff_ms)).toBe(65000);
    await expect(register(f,nonce(now))).rejects.toThrow("prekey_floor_not_passed");
    expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows).toHaveLength(0);
  });
  it("persisted owner/clock/floor anomalies refuse; authenticated-timestamp metadata must strictly exceed floor",async()=>{
    for(const drift of ["owner","clock","floor"]){const f=await fixture();
      if(drift==="owner")await db.query("UPDATE next_prekey_http_nonce_floors SET owner_user_id=$2 WHERE collection_id=$1",[f.col,randomUUID()]);
      if(drift==="clock")await db.query("UPDATE next_prekey_http_nonce_floors SET last_cp_now_ms=$2 WHERE collection_id=$1",[f.col,f.now+5000]);
      if(drift==="floor")await db.query("UPDATE next_prekey_http_nonce_floors SET cutoff_ms=$2,not_before_ms=$3,last_cp_now_ms=$2 WHERE collection_id=$1",[f.col,f.now-65000,f.now]);
      await expect(register(f,nonce(f.now))).rejects.toThrow(drift==="floor"?"prekey_floor_not_passed":"prekey_floor_unavailable");
      expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows).toHaveLength(0);
      if(drift==="floor")expect(await register(f,nonce(f.now+1))).toBe(true);
    }
  });
  it("equality is live and GC cutoff equality remains retained within the actual transaction",async()=>{
    const f=await fixture();await inTransaction(db as unknown as DatabasePool,async c=>{
      await lockCpNonceOwner(c as unknown as pg.PoolClient,f.owner);await lock(c,f.col);
      const now=await cpStatementNow(c as unknown as pg.PoolClient),edge=Buffer.alloc(32,0x78),live=Buffer.alloc(32,0x79);
      await c.query(`INSERT INTO next_prekey_http_nonce_uses(collection_id,owner_user_id,http_nonce,transcript_hash,challenge,nonce_expires_ms)
        SELECT $1,$2,decode(lpad(to_hex(i),64,'0'),'hex'),decode(repeat('37',32),'hex'),decode(repeat('35',32),'hex'),$3 FROM generate_series(1,4096) i`,[f.col,f.owner,now]);
      await expect(registerCpNonce(c as unknown as pg.PoolClient,f.col,f.owner,nonce(now),Buffer.alloc(32,1),Buffer.alloc(32,2),now)).rejects.toThrow("prekey_capacity");
      await c.query("DELETE FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col]);
      for(const [n,expiry] of [[edge,now-86465000],[live,now]] as const)await c.query("INSERT INTO next_prekey_http_nonce_uses VALUES($1,$2,$3,$4,$5,$6)",[f.col,f.owner,n,Buffer.alloc(32,1),Buffer.alloc(32,2),expiry]);
      expect(await registerCpNonce(c as unknown as pg.PoolClient,f.col,f.owner,nonce(now),Buffer.alloc(32,1),Buffer.alloc(32,2),now)).toBe(true);
      expect((await c.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows).toHaveLength(3);
    });
  });
  it("enforces actual byte constraints, no FK/cascade and ordinary table deletion cannot erase tombstones",async()=>{
    const f=await fixture();for(const index of [2,3,4])for(const invalid of [Buffer.alloc(31),Buffer.alloc(32)]){
      const values:unknown[]=[f.col,f.owner,nonce(f.now),Buffer.alloc(32,1),Buffer.alloc(32,2),f.now+60000];values[index]=invalid;
      await expect(db.query("INSERT INTO next_prekey_http_nonce_uses VALUES($1,$2,$3,$4,$5,$6)",values)).rejects.toMatchObject({code:"23514"});}
    await register(f,nonce(f.now));await db.query("CREATE TABLE IF NOT EXISTS test_owner(id uuid PRIMARY KEY)");await db.query("INSERT INTO test_owner VALUES($1)",[f.owner]);await db.query("DELETE FROM test_owner WHERE id=$1",[f.owner]);
    expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE owner_user_id=$1",[f.owner])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM pg_constraint WHERE connamespace=$1::regnamespace AND contype='f'",[schema])).rows).toHaveLength(0);
  });
  async function fill(f:{col:string;owner:string},now:number,count:number,expiry:number){
    await db.query(`INSERT INTO next_prekey_http_nonce_uses(collection_id,owner_user_id,http_nonce,transcript_hash,challenge,nonce_expires_ms)
      SELECT $1,$2,decode(lpad(to_hex(i),64,'0'),'hex'),decode(repeat('37',32),'hex'),decode(repeat('35',32),'hex'),$3 FROM generate_series(1,$4) i`,[f.col,f.owner,expiry,count]);
  }
  it("collection live quota includes equality; expired storage is not a permanent cap",async()=>{
    const f=await fixture();await fill(f,f.now,4096,f.now+60000);await expect(register(f,nonce(f.now))).rejects.toThrow("prekey_capacity");
    await db.query("UPDATE next_prekey_http_nonce_uses SET nonce_expires_ms=$2 WHERE collection_id=$1",[f.col,f.now-1]);
    expect(await register(f,nonce(f.now))).toBe(true);expect((await db.query("SELECT count(*)::integer AS n FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows[0].n).toBe(4097);
  });
  it("account quota serializes across different collections without a deleted-owner join",async()=>{
    const owner=randomUUID(),a=await fixture(owner),b=await fixture(owner),c=await fixture(owner);await fill(a,a.now,4096,a.now+60000);await fill(b,b.now,4095,b.now+60000);
    const results=await Promise.allSettled([register(b,nonce(b.now)),register(c,nonce(c.now))]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect((await db.query("SELECT count(*)::integer AS n FROM next_prekey_http_nonce_uses WHERE owner_user_id=$1",[owner])).rows[0].n).toBe(8192);
  });
  it("GC removes only a bounded batch past TTL+skew+24h margin, never floor/live rows",async()=>{
    const f=await fixture();await fill(f,f.now,70,f.now-86465000-1000);await db.query("INSERT INTO next_prekey_http_nonce_uses VALUES($1,$2,$3,$4,$5,$6)",
      [f.col,f.owner,Buffer.alloc(32,0x77),Buffer.alloc(32,1),Buffer.alloc(32,2),f.now+60000]);
    await register(f,nonce(f.now));expect((await db.query("SELECT count(*)::integer AS n FROM next_prekey_http_nonce_uses WHERE collection_id=$1",[f.col])).rows[0].n).toBe(8);
    expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_floors WHERE collection_id=$1",[f.col])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM next_prekey_http_nonce_uses WHERE collection_id=$1 AND http_nonce=$2",[f.col,Buffer.alloc(32,0x77)])).rows).toHaveLength(1);
  });
});
