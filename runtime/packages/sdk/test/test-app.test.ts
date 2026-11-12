import {expect,it} from "vitest";
import {createTestApp,createTestMdbase} from "../src/testing/index.js";
import {describeError} from "../src/describe-error.js";

it("createTestApp: preset screens, real records when ready, and realistic faults",async()=>{
  const app=await createTestApp({phase:"signed_out",collections:[{name:"Notes",records:[{path:"hello.md",body:"Hi"}]},{name:"Work"}]});
  try{
    const a=app.mdbase;
    expect(a.getSnapshot().phase).toEqual({kind:"signed_out",notice:null});
    app.fail({action:"authorize",outcome:"closed"});await a.signIn();
    expect(a.getSnapshot().phase).toMatchObject({kind:"signed_out",notice:{key:"approval_window_closed"}});
    await a.signIn();expect(a.getSnapshot().phase).toMatchObject({kind:"choosing",lastApproval:{outcome:"added"}});
    const notes=a.getSnapshot().collections[0]!.collectionId;
    await a.select(notes);
    const phase=a.getSnapshot().phase;expect(phase.kind).toBe("ready");
    if(phase.kind==="ready")expect((await phase.connection.records.query({})).records.map(r=>r.path)).toEqual(["hello.md"]);
    expect(a.getSnapshot().sync).toMatchObject({state:"saved",connection:"online",pending:0});
    app.fail({action:"applySetup",reason:"setup_changed"});app.set("needs_setup");
    await expect(a.setup.apply({} as never)).resolves.toMatchObject({outcome:"changed"});
    app.fail({action:"select",problem:"access_removed"});await a.select(notes);
    expect(describeError(a.getSnapshot())).toMatchObject({key:"access_removed"});
    expect(a.getSnapshot().phase).toMatchObject({kind:"problem",problem:{key:"access_removed"}});
    app.set("second_tab");expect(a.getSnapshot().phase).toMatchObject({kind:"problem",problem:{key:"open_in_another_tab"}});
  }finally{await app.close();}
});

it("createTestMdbase: the createMdbase front door over the fixture",async()=>{
  const mdbase=await createTestMdbase({phase:"signed_out",collections:[{name:"Notes",records:[{path:"hello.md",body:"Hi"}]}]});
  try{
    expect((await mdbase.signIn()).phase).toMatchObject({kind:"choosing"});
    const snap=await mdbase.select(mdbase.getSnapshot().collections[0]!.collectionId);
    expect(snap.phase?.kind).toBe("ready");
    if(snap.phase?.kind==="ready")expect((await snap.phase.connection.records.query({})).records.map(r=>r.path)).toEqual(["hello.md"]);
    mdbase.fixture.fail({action:"applySetup",reason:"setup_changed"});mdbase.fixture.set("needs_setup");
    expect((await mdbase.setup.apply({} as never)).outcome).toBe("changed");
  }finally{await mdbase.close();}
});

it("createTestApp: a locked Private collection, a wrong secret, then an unlock that opens it",async()=>{
  const app=await createTestApp({phase:{needsUnlock:"password"},collections:[{name:"Journal",records:[{path:"today.md",body:"Hi"}]}]});
  try{
    const a=app.mdbase,id=a.getSnapshot().collections[0]!.collectionId;
    expect(a.getSnapshot().phase).toEqual({kind:"needs_unlock",collectionId:id,displayName:"Journal",mode:"password",unlocking:false,problem:null});
    app.fail({action:"unlock",problem:"wrong_secret"});
    const wrong=await a.unlock(id,{password:"not the password"});
    expect(wrong.phase).toMatchObject({kind:"needs_unlock",mode:"password",unlocking:false,problem:{key:"wrong_secret"}});
    const opened=await a.unlock(id,{recoveryKey:"AAAA-BBBB-CCCC"});
    expect(opened.phase?.kind).toBe("ready");
    if(opened.phase?.kind==="ready")expect((await opened.phase.connection.records.query({})).records.map(r=>r.path)).toEqual(["today.md"]);
    // Only a collection waiting to be unlocked can be unlocked.
    await expect(a.unlock(id,{password:"correct horse battery staple"})).rejects.toMatchObject({code:"invalid_request",reason:"unlock_not_locked"});
    // The fixture records which kind of secret was given, never the secret.
    const all=app.controls.observedActions(),calls=all.filter(call=>call.action==="unlock");
    expect(calls.map(call=>call.secret)).toEqual(["password","recoveryKey","password"]);
    expect(JSON.stringify(all)).not.toContain("not the password");expect(JSON.stringify(all)).not.toContain("AAAA-BBBB");
    for(const mode of ["strict","none"] as const){app.set({needsUnlock:mode});expect(a.getSnapshot().phase).toMatchObject({kind:"needs_unlock",mode,problem:null});}
  }finally{await app.close();}
});

it("createTestMdbase: unlock through the front door",async()=>{
  const mdbase=await createTestMdbase({phase:{needsUnlock:"password"},collections:[{name:"Journal"}]});
  try{
    const id=mdbase.getSnapshot().collections[0]!.collectionId;
    expect(mdbase.getSnapshot().phase).toMatchObject({kind:"needs_unlock",collectionId:id,mode:"password"});
    mdbase.fixture.fail({action:"unlock",problem:"rate_limited"});
    expect((await mdbase.unlock(id,{password:"correct horse battery staple"})).phase).toMatchObject({kind:"needs_unlock",problem:{key:"rate_limited"}});
    expect((await mdbase.unlock(id,{password:"correct horse battery staple"})).phase?.kind).toBe("ready");
  }finally{await mdbase.close();}
});
