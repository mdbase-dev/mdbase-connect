/** Native producer replaces the former local resourceOps/ordinary-submit path. */
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {privateCollectionSetup} from "../src/app-grant/setup.js";
import {setupPlan} from "../src/application/setup.js";
import {nativeSetupFixture} from "./fixtures/native-setup-producer.js";
const JOURNAL=JSON.parse(readFileSync(new URL("./fixtures/journal-private-setup.json",import.meta.url),"utf8"));
describe("Private collection setup",()=>{
  it("reviews declaration-bound v2 setup without granting arbitrary definition management",async()=>{
    const f=await nativeSetupFixture(JOURNAL),plan=await f.setup.plan();
    expect(plan.canApply).toBe(true);expect(plan.refusal).toBeUndefined();
    expect(f.methods).not.toContain("submit");
  });
  it("does not translate declaration-bound setup into ordinary resource writes",async()=>{
    const f=await nativeSetupFixture(JOURNAL);
    expect(await f.setup.apply(await f.setup.plan())).toBe("ready");
    expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(1);
    expect(f.methods).not.toContain("submit");
    expect(f.state.attempt).toBeUndefined();
  });
  it("reviews in plain words then applies exactly one original reviewed Native mutation",async()=>{
    const f=await nativeSetupFixture(JOURNAL);
    expect(await f.setup.assess()).toBe("setup_required");
    const plan=await f.setup.plan();
    expect(plan).toMatchObject({status:"setup",canApply:true,summary:"This app will make 1 change to this collection. Nothing already in it is changed."});
    expect(plan.changes).toEqual([{kind:"create",target:"_types/task.md",message:"Add the note type for this app."}]);
    expect(await f.setup.apply(plan)).toBe("ready");
    expect(await f.setup.assess()).toBe("ready");expect(f.methods).not.toContain("submit");
    await expect(f.setup.apply(plan)).rejects.toMatchObject({reason:"setup_changed"});
  });
  it("releases assessment-only Native reviews, including an already-current collection",async()=>{
    for(const installed of [false,true]){
      const f=await nativeSetupFixture(JOURNAL);f.state.installed=installed;
      expect(await f.setup.assess()).toBe(installed?"ready":"setup_required");
      expect(f.requests.map(r=>r.get(1))).toEqual(["assess","cancel"]);
      expect(f.state.attempt).toBeUndefined();expect(f.methods).not.toContain("submit");
    }
  });
  it("refreshes a review retired by a second plan and applies only identical consented changes",async()=>{
    const f=await nativeSetupFixture(JOURNAL),a=await f.setup.plan();
    const b=await f.setup.plan();expect(a.digest).toBe(b.digest);
    expect(await f.setup.apply(a)).toBe("ready");
    expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(2);
    expect(f.requests.filter(r=>r.get(1)==="assess")).toHaveLength(4);
    expect(f.state.attempt).toBeUndefined();expect(f.methods).not.toContain("submit");
  });
  it("requires re-consent when another setup controller retires a review and the fresh digest differs",async()=>{
    const f=await nativeSetupFixture(JOURNAL),a=await f.setup.plan();
    f.state.digest=4;const other=privateCollectionSetup(f.input),b=await other.plan();
    expect(a.digest).not.toBe(b.digest);
    await expect(f.setup.apply(a)).rejects.toMatchObject({code:"conflict",reason:"setup_changed"});
    expect(f.state.installed).toBe(false);expect(f.state.attempt).toBeUndefined();
    expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(1);
    expect((await f.setup.plan()).digest).toBe(b.digest);
  });
  it("re-plans at most once if another actor retires the replacement review too",async()=>{
    const f=await nativeSetupFixture(JOURNAL),a=await f.setup.plan();f.state.retireOnApply=2;
    await expect(f.setup.apply(a)).rejects.toMatchObject({code:"conflict",reason:"setup_changed"});
    expect(f.requests.filter(r=>r.get(1)==="assess")).toHaveLength(2);
    expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(2);
    expect(f.state.installed).toBe(false);expect(f.state.attempt).toBeUndefined();
  });
  it("retains the original starter bytes and adoption decisions when refreshing a retired review",async()=>{
    const f=await nativeSetupFixture(JOURNAL),records=[{path:"Welcome.md",document:"Original\n"}],adopt={"_types/task.md":`sha256:${"ab".repeat(32)}`};
    const a=await f.setup.plan({records,adopt});
    records[0]!.document="Unconsented replacement\n";adopt["_types/task.md"]=`sha256:${"cd".repeat(32)}`;
    await f.setup.plan();expect(await f.setup.apply(a)).toBe("ready");
    const assessments=f.requests.filter(r=>r.get(1)==="assess");
    expect(assessments[2]!.get(3)).toEqual(assessments[0]!.get(3));
    expect(assessments[2]!.get(4)).toEqual(assessments[0]!.get(4));
  });
  it("never auto-applies a different existing-file impact even if the Core assessment digest is identical",async()=>{
    const f=await nativeSetupFixture(JOURNAL),a=await f.setup.plan();f.state.promoted=1;await f.setup.plan();
    await expect(f.setup.apply(a)).rejects.toMatchObject({reason:"setup_changed"});
    expect(f.state.installed).toBe(false);expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(1);
    const fresh=await f.setup.plan();expect(fresh.changes).toContainEqual(expect.objectContaining({target:"Existing files"}));
  });
  it("preserves certified Native stale-review refusal and its original MID",async()=>{
    const f=await nativeSetupFixture(JOURNAL),plan=await f.setup.plan();f.state.stale=true;
    await expect(f.setup.apply(plan)).rejects.toMatchObject({code:"conflict",reason:"setup_changed",mutationId:expect.any(String)});
    expect(f.state.installed).toBe(false);expect(f.state.attempt).toBeUndefined();expect(f.methods).not.toContain("submit");
  });
  it.each(["conflict","not_found"] as const)("never replays after transport loss even when its code looks like a certified %s",async(dropCode)=>{
    const f=await nativeSetupFixture(JOURNAL,{dropApply:true,dropCode}),plan=await f.setup.plan();
    await expect(f.setup.apply(plan)).rejects.toMatchObject({code:"outcome_unknown",mutationId:expect.any(String)});
    const mid=f.state.attempt;expect(mid).toBe(f.state.mid);
    await expect(f.setup.apply(plan)).rejects.toMatchObject({reason:"setup_changed"});
    // Cold setup instance reconciles ONLY the retained MID, then reads current state.
    const recovered=privateCollectionSetup(f.input);
    expect((await recovered.plan()).status).toBe("current");
    expect(f.state.attempt).toBeUndefined();expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(1);
  });
  it("refuses missing negotiation even for a broad grant, and refuses oversized replies",async()=>{
    const old=await nativeSetupFixture(JOURNAL,{support:false,capabilities:["definitions.manage","records.create"]});
    await expect(old.setup.plan()).rejects.toMatchObject({code:"upgrade_required"});
    expect(old.methods).not.toContain("app_collection_setup_v1");expect(old.methods).not.toContain("submit");
    const large=await nativeSetupFixture(JOURNAL,{oversized:true});
    await expect(large.setup.plan()).rejects.toMatchObject({code:"internal"});expect(large.methods).not.toContain("submit");
  });
  it("binds starter records and refuses a replacement original session before dispatch",async()=>{
    const f=await nativeSetupFixture(JOURNAL);
    const plan=await f.setup.plan({records:[{path:"Welcome.md",document:"Welcome\n"}]});
    expect(plan.records).toEqual([{path:"Welcome.md",action:"create"}]);
    expect(f.requests[0]!.has(4)).toBe(true);
    f.client.close();await expect(f.setup.apply(plan)).rejects.toBeDefined();
    expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(0);
  });
  it("polls the same Native ticket and freezes starter inputs throughout review",async()=>{
    const f=await nativeSetupFixture(JOURNAL,{pending:true});
    const plan=await f.setup.plan({records:[{path:"Welcome.md",document:"Welcome\\n"}]});
    expect(plan.records).toEqual([{path:"Welcome.md",action:"create"}]);
    expect(f.requests.map(r=>r.get(1))).toEqual(["assess","poll"]);
    expect(f.requests[0]!.get(4)).toBeDefined();expect(f.requests[1]!.has(4)).toBe(false);
  });
  it("cancels unsent pending review without submitting setup or retaining a MID",async()=>{
    const f=await nativeSetupFixture(JOURNAL,{pendingForever:true}),abort=new AbortController();
    setTimeout(()=>abort.abort(),5);
    await expect(f.setup.plan({signal:abort.signal})).rejects.toMatchObject({code:"cancelled"});
    expect(f.requests.map(r=>r.get(1))).toContain("cancel");
    expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(0);expect(f.state.attempt).toBeUndefined();
  });
  it("blocks another setup while the original receipt is still pending",async()=>{
    const f=await nativeSetupFixture(JOURNAL,{dropApply:true,receiptPending:true});
    await expect(f.setup.apply(await f.setup.plan())).rejects.toMatchObject({code:"outcome_unknown"});
    const mid=f.state.attempt;await expect(privateCollectionSetup(f.input).plan()).rejects.toMatchObject({code:"outcome_unknown",mutationId:mid});
    expect(f.state.attempt).toBe(mid);expect(f.requests.filter(r=>r.get(1)==="apply")).toHaveLength(1);
  });
  it("explains the purpose of setup without internal record names, paths or setting keys", () => {
    const resource = (target: string, kind: string) => ({ target, kind, mode: "managed" as const, action: "create" as const, installed: false });
    const plan = setupPlan({ status: "provision", assessmentDigest: `sha256:${"1".repeat(64)}`, review: { configuration: [
        { requirement: "app-files", path: "/settings/include", value: "Internal/Views/**/*.base", action: "add" },
        { requirement: "file-format", path: "/settings/record_extensions", value: "base", action: "add" },
        { requirement: "app-setting", path: "/settings/internal_setting", value: true, action: "add" }], staged: [],
      packs: [{ id: "org.example.reader", version: "1.0.0", status: "install", installedVersion: null, resources: [
        resource("_contracts/org.example.reader.source.md", "contract"), resource("_contracts/org.example.comment/1.0.0.md", "contract"),
        resource("_types/reader-source.md", "type"), resource("schemas/org.example.comment/1.0.0.schema.json", "schema")] }] } }, { canManage: true, canCreateRecords: true, records: [] });
    expect(plan.summary).toBe("This app will make 7 changes to this collection.");
    expect(plan.changes.map(c => c.message)).toEqual([
      "Add the shared format for this app's notes, so other apps can work with them.",
      "Add the shared format for this app's notes, so other apps can work with them.",
      "Add the note type for this app.",
      "Add the set of checks for this app's note properties.",
      "Include this app's files when reading the collection.",
      "Read .base files as notes in this collection.",
      "Adjust a collection setting this app needs."]);
    expect(plan.changes.map(c => c.target)).toEqual(["_contracts/org.example.reader.source.md", "_contracts/org.example.comment/1.0.0.md", "_types/reader-source.md", "schemas/org.example.comment/1.0.0.schema.json", "include", "record extensions", "internal setting"]);
    expect(plan.changes.map(c => c.message).join(" ")).not.toMatch(/reader|comment|Internal\/|include setting|record extensions setting|internal setting/i);
  });
});
