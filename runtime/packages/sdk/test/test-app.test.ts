import {expect,it} from "vitest";
import {createTestApp,createTestMdbase} from "../src/testing/index.js";
import {describeError} from "../src/describe-error.js";

it("createTestApp: preset screens, real records when ready, and production-shaped faults",async()=>{
  const app=await createTestApp({phase:"signed_out",collections:[{name:"Notes",records:[{path:"hello.md",body:"Hi"}]},{name:"Work"}]});
  try{
    const a=app.application;
    expect(a.getSnapshot().phase).toEqual({kind:"signed_out",notice:null});
    app.fail({action:"authorize",outcome:"closed"});await a.authorize();
    expect(a.getSnapshot().phase).toMatchObject({kind:"signed_out",notice:{key:"approval_window_closed"}});
    await a.authorize();expect(a.getSnapshot().phase).toMatchObject({kind:"choosing",lastApproval:{outcome:"added"}});
    const notes=a.getSnapshot().collections[0]!.collectionId;
    await a.select(notes);
    const phase=a.getSnapshot().phase!;expect(phase.kind).toBe("ready");
    if(phase.kind==="ready")expect((await phase.connection.records.query({})).records.map(r=>r.path)).toEqual(["hello.md"]);
    expect(a.getSnapshot().sync).toMatchObject({kind:"synced"});
    app.fail({action:"applySetup",reason:"setup_changed"});app.set("needs_setup");
    await expect(a.setup.apply({} as never)).rejects.toMatchObject({code:"conflict",reason:"setup_changed"});
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
