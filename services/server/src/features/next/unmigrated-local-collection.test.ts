import {randomBytes,randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createDatabase,type DatabasePool} from "../../db.js";
import {localGrantFixture} from "./next-fixtures.test-helper.js";
import {unmigratedLocalCollection} from "./native-grant-target.js";
import {cutoverProblem,CutoverProblemError,DEFAULT_CLIENT_UPDATE_POLICY} from "./cutover-problems.js";

describe("positive collection-specific legacy local authority",()=>{
  let db:DatabasePool;
  beforeAll(async()=>{db=await createDatabase();});
  afterAll(async()=>{await db?.end();});
  async function local(){
    const id=await localGrantFixture(db);
    await db.query("UPDATE collections SET enabled=true,present=true,authority_state='active' WHERE id=$1",[id]);
    return id;
  }
  async function enroll(connector:string,owner=connector){
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [randomUUID(),connector,owner,randomBytes(32),randomBytes(32),randomBytes(32)]);
  }
  it("requires positive current legacy authority, not a missing next row",async()=>{
    const id=await local();
    expect(await unmigratedLocalCollection(db,id,id)).toBe(true);
    expect(await unmigratedLocalCollection(db,randomUUID(),id)).toBe(false);
    expect(await unmigratedLocalCollection(db,id,randomUUID())).toBe(false);
  });
  it("is collection-specific even after the account backend flips and another desktop upgrades",async()=>{
    const id=await local(),other=randomUUID();
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1",[id]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Other computer',$3)",[other,id,randomUUID()]);
    await enroll(other,id);
    expect(await unmigratedLocalCollection(db,id,id)).toBe(true);
    await enroll(id);
    // A next local-only collection legitimately has no next_collections row.
    expect(await unmigratedLocalCollection(db,id,id)).toBe(false);
  });
  it.each(["shadow","next"])("does not relabel a %s collection as not-yet-migrated",async runtime=>{
    const id=await local();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$1,$2,'private',$3)",[id,runtime,Buffer.alloc(16)]);
    expect(await unmigratedLocalCollection(db,id,id)).toBe(false);
  });
  it.each([
    "UPDATE collections SET enabled=false WHERE id=$1",
    "UPDATE collections SET present=false WHERE id=$1",
    "UPDATE collections SET removed_at=now() WHERE id=$1",
    "UPDATE collections SET authority_state='candidate' WHERE id=$1",
    "UPDATE collections SET authority_state='retired' WHERE id=$1",
    "UPDATE connectors SET revoked_at=now() WHERE id=$1",
    "UPDATE users SET suspended_at=now() WHERE id=$1",
  ])("never explains unavailable or unauthorized authority as migration: %s",async sql=>{
    const id=await local();await db.query(sql,[id]);
    expect(await unmigratedLocalCollection(db,id,id)).toBe(false);
  });
  it("keeps the upgrade explanation plain and separate from an active migration timer",()=>{
    const problem=cutoverProblem(new CutoverProblemError("not_yet_migrated"),DEFAULT_CLIENT_UPDATE_POLICY);
    expect(problem).toEqual({status:409,code:"collection_not_yet_migrated",
      message:"This collection will appear here once you update the mdbase desktop app on the computer that holds it."});
    expect(problem.message).not.toMatch(/legacy|daemon|runtime|grant/i);
    expect(cutoverProblem(new CutoverProblemError("migrating"),DEFAULT_CLIENT_UPDATE_POLICY)).toMatchObject({code:"collection_migrating",retryAfterSeconds:300});
  });
});
