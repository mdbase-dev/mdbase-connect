import { collectionDeleteError } from "../src/app-host/collection-delete.js";
import { describeError } from "../src/describe-error.js";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProtectedInstallationSignIn } from "../src/app-host/installation-sign-in.js";
import { AppInstallationStore } from "../src/app-host/installation-store.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
const origin = "https://notes.example.test", cpOrigin = "https://cp.example.test", appName = "Independent Notes";
const account = "11111111-1111-4111-8111-111111111111", connector = "22222222-2222-4222-8222-222222222222";
const pk = {signPublicKey: new Uint8Array(32).fill(3), kemPublicKey: new Uint8Array(32).fill(4), noisePublicKey: new Uint8Array(32).fill(5)};
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(requestedCreateCollections = false, extra: {installationKind?: "app-runtime" | "mobile"; owner?: string} = {}) {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("location", {origin});
  const trace: string[] = [], requests: {path: string; body: unknown; bearer: unknown}[] = [];
  let saved: Uint8Array | null = null, current = true, selected = false, approved = false, commitFailure = false, failHttp = false, oversized = false;
  let change: (v: Record<string, unknown>) => void = () => {};
  const read = () => JSON.parse(new TextDecoder().decode(saved!));
  const store = {isCurrent: () => current, commit: async (value: Uint8Array) => { saved?.fill(0); saved = new Uint8Array(value); trace.push("protected-commit"); if (commitFailure) { current = false; throw Error("lost reply"); } }, close: async () => {current = false; trace.push("closed");}};
  vi.spyOn(AppInstallationStore, "open").mockImplementation(async (p, initial) => {
    current = true;
    if (p.mode === "fresh") {if (saved) throw Error("existing"); saved = initial(); trace.push("protected-original");}
    else if (!saved) throw Error("missing-existing");
    return {store: store as unknown as AppInstallationStore, plaintext: new Uint8Array(saved!)};
  });
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(saved).not.toBeNull(); const state = read(); trace.push("http");
    expect(init).toMatchObject({method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
    const path = new URL(String(input)).pathname, body = init?.body === undefined ? undefined : JSON.parse(String(init.body)), bearer = (init?.headers as Record<string, string>)?.authorization;
    requests.push({path, body, bearer}); if (failHttp) throw Error("lost HTTP reply");
    let status = 200, value: Record<string, unknown>;
    const selection = {request_id: state.requestId, account_id: account, connector_id: connector, device_id: state.deviceId, installation_id: state.installationId, kind: state.kind, challenge: "ab".repeat(32), approval_mode: "password-ak1", app_id: state.appId, app_origin: state.origin, expires_at: Date.now() + 600000};
    if (path === "/v1/pairing-requests") {
      expect(body.installation).toEqual({app_id: state.appId, request_id: state.requestId, pairing_secret: state.secret, installation_id: state.installationId, device_id: state.deviceId, kind: state.kind, requested_create_collections: state.requestedCreateCollections ?? false, ...(state.renewal ? {renewal:{request_id:state.renewal.requestId,pairing_secret:state.renewal.secret}} : {})}); expect(bearer).toBeUndefined();
      value = {pairing_id: state.requestId, pairing_secret: state.secret, verification_uri: `${cpOrigin}/pair/${state.requestId}`, expires_in: 600, installation_device: true, app_id: state.appId, app_origin: state.origin, app_name: appName};
    } else {
      expect(bearer).toBe(`Bearer ${state.secret}`);
      if (path.endsWith("/attest")) { expect(body).toEqual(state.proof); expect(trace).toContain("protected-commit"); value = {ok: true}; }
      else if (!selected) {status = 202; value = {status: "pending"};}
      else if (!state.proof) {status = 202; value = {status: "account_selected", ...selection};}
      else if (!approved) {status = 202; value = {status: "awaiting_approval", ...selection};}
      else value = {status: "paired", ...selection, connector: {id: connector, name: appName}, token: `idev_${"a".repeat(43)}`, registration: {device_id: state.deviceId, sign_pk: hex(pk.signPublicKey), kem_pk: hex(pk.kemPublicKey), noise_pk: hex(pk.noisePublicKey)}};
    }
    change(value); if (oversized) value = {padding: "a".repeat(65537)};
    return new Response(JSON.stringify(value), {status});
  }) as unknown as typeof fetch;
  const options = {origin, cpOrigin, appId: "44444444-4444-4444-8444-444444444444", appName, environment: "lab" as const, mode: "fresh" as "fresh" | "existing", signal: new AbortController().signal, locks: undefined, fetch: request, requestedCreateCollections, ...extra};
  const flow = await AppProtectedInstallationSignIn.open(options);
  const installation = {scope: {account, installation: flow.view().installationId}, isCurrent: () => true};
  const custody = {...pk, envelope: new Uint8Array([6, 7])};
  const runtime = {deviceCustodyCurrent: (_pin: unknown, c: unknown) => c === custody, signCpEnrol: vi.fn(() => {trace.push("native-fixed-sign"); return {...pk, signature: new Uint8Array(64).fill(8)};}), acknowledgeDeviceRegistration: vi.fn(() => {trace.push("native-ack"); expect(read().token).toMatch(/^idev_/);})} as unknown as AppWasmRuntime;
  const persistence = {pending: vi.fn(async () => {trace.push("protected-noise-pending");}), registered: vi.fn(async () => {trace.push("protected-receipt");})};
  return {flow, options, installation, custody, runtime, persistence, trace, requests, read, request, editSaved:(change:(s:Record<string,unknown>)=>void)=>{const s=read();change(s);saved=new TextEncoder().encode(JSON.stringify(s));}, setSelected: () => {selected = true;}, setApproved: () => {approved = true;}, setFailHttp: () => {failHttp = true;}, setCommitFailure: () => {commitFailure = true;}, setOversized: () => {oversized = true;}, change: (fn: typeof change) => {change = fn;}};
}
const expiredReply = () => new Response(JSON.stringify({error:{code:"installation_pairing_expired",message:"expired"}}),{status:404});
describe("installation kind", () => {
  it("binds mobile into the stored request and pairing body; a different kind cannot reopen it", async () => {
    const f = await fixture(false, {installationKind: "mobile"});
    expect(f.read().kind).toBe("mobile");
    await f.flow.start().catch(() => {});
    expect((f.requests[0]!.body as {installation: {kind: string}}).installation.kind).toBe("mobile");
    await expect(AppProtectedInstallationSignIn.open({...f.options, mode: "existing", installationKind: "app-runtime"})).rejects.toMatchObject({reason: "recovery_required"});
  });
  it("restores only a record labelled with the same local owner", async () => {
    const owner = "bundle:dev.example.notes", f = await fixture(false, {owner});
    expect(f.read().owner).toBe(owner);
    await expect(AppProtectedInstallationSignIn.open({...f.options, mode: "existing"})).resolves.toBeDefined();
    for (const other of [{owner: "bundle:dev.example.other"}, {owner: undefined}])
      await expect(AppProtectedInstallationSignIn.open({...f.options, ...other, mode: "existing"})).rejects.toMatchObject({reason: "recovery_required"});
  });
});
describe("explicit expired-window retry preserves original actor", () => {
  it("commits a new request/parent capability before HTTP, retaining actor and create policy",async()=>{
    const f=await fixture(true), original=f.read();vi.mocked(f.request).mockResolvedValueOnce(expiredReply());
    await expect(f.flow.start()).rejects.toMatchObject({reason:"expired"});
    const next=await f.flow.renewExpiredPairing(), saved=f.read();
    expect(next.requestId).not.toBe(original.requestId);expect(saved.secret).not.toBe(original.secret);
    expect(saved.renewal).toEqual({requestId:original.requestId,secret:original.secret});
    for(const key of ['installationId','deviceId','appId','kind','origin','cpOrigin','requestedCreateCollections'])expect(saved[key]).toEqual(original[key]);
    expect(f.trace.indexOf('protected-commit')).toBeLessThan(f.trace.indexOf('http'));expect(f.requests).toHaveLength(1);
  });
  it.each(['installation_pairing_not_found'])("does not authorize retry from arbitrary404 %s",async code=>{
    const f=await fixture(), original=f.read();vi.mocked(f.request).mockResolvedValueOnce(new Response(JSON.stringify({error:{code}}),{status:404}));
    await expect(f.flow.start()).rejects.toMatchObject({reason:'refused'});await expect(f.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});expect(f.read()).toEqual(original);
  });
  it("never renews a pending, paired, or unknown-outcome request",async()=>{
    const f=await fixture();await expect(f.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});f.setFailHttp();await expect(f.flow.start()).rejects.toMatchObject({reason:'outcome_unknown'});await expect(f.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});
    const p=await paired();await expect(p.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});
  });
  it("unknown renewal outcome/restart retain the SAME new request, never a second retry actor",async()=>{
    const f=await fixture();vi.mocked(f.request).mockResolvedValueOnce(expiredReply());await expect(f.flow.start()).rejects.toMatchObject({reason:'expired'});f.setFailHttp();
    await expect(f.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'outcome_unknown'});const saved=f.read(), request=f.requests[0]!.body;
    await expect(f.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});await f.flow.close();
    const flow=await AppProtectedInstallationSignIn.open({...f.options,mode:'existing'});await expect(flow.start()).rejects.toMatchObject({reason:'outcome_unknown'});
    expect(f.read()).toEqual(saved);expect(f.requests[1]!.body).toEqual(request);await flow.close();
  });
  it.each(['abort','failed-commit'] as const)("%s clears retained RAM parent capability without deleting the durable successor",async mode=>{
    const f=await fixture(), parent=new AbortController(); await f.flow.close();
    const flow=await AppProtectedInstallationSignIn.open({...f.options,mode:'existing',signal:parent.signal});
    vi.mocked(f.request).mockResolvedValueOnce(expiredReply()); await expect(flow.start()).rejects.toMatchObject({reason:'expired'}); await flow.renewExpiredPairing();
    // Inspect only the test stand-in's RAM object; never expose a product getter.
    const ram=(flow as unknown as {state:{secret:string;renewal:{secret:string}|null}}).state, retainedParent=ram.renewal!;
    if(mode==='failed-commit') {
      vi.mocked(f.request).mockResolvedValueOnce(expiredReply()); await expect(flow.start()).rejects.toMatchObject({reason:'expired'}); f.setCommitFailure();
      await expect(flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});
    }
    const durable=f.read(), commits=f.trace.filter(v=>v==='protected-commit').length;
    if(mode==='abort') parent.abort(); else await flow.close();
    expect(ram.secret).toBe(''); expect(retainedParent.secret).toBe(''); expect(ram.renewal).toBeNull();
    expect(f.read()).toEqual(durable); expect(f.trace.filter(v=>v==='protected-commit')).toHaveLength(commits);
    const reopened=await AppProtectedInstallationSignIn.open({...f.options,mode:'existing'});
    expect((await reopened.start()).requestId).toBe(durable.requestId); expect(f.read()).toEqual(durable); await reopened.close();
  });
  it("retains original confirmed selection, keys, challenge and proof on expiry",async()=>{
    const f=await fixture();await confirmed(f);await f.flow.attest(f);const original=f.read(), signs=vi.mocked(f.runtime.signCpEnrol).mock.calls.length;
    vi.mocked(f.request).mockResolvedValueOnce(expiredReply());await expect(f.flow.exchange()).rejects.toMatchObject({reason:'expired'});await f.flow.renewExpiredPairing();
    for(const key of ['selection','confirmed','nativeStarted','proof'])expect(f.read()[key]).toEqual(original[key]);expect(f.runtime.signCpEnrol).toHaveBeenCalledTimes(signs);
  });
  it.each([1])("opens protected v%s without inventing a renewal parent",async version=>{
    const f=await fixture(), original=f.flow.view();await f.flow.close();f.editSaved(s=>{s.version=version;delete s.renewal;if(version===1)for(const key of ['requestedCreateCollections','collectionIds','createCollections','consentRequest'])delete s[key];});
    const flow=await AppProtectedInstallationSignIn.open({...f.options,mode:'existing'});expect(await flow.start()).toEqual(original);await expect(flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});await flow.close();
  });
  it("refuses malformed or self-parent protected renewal before HTTP",async()=>{
    for(const corrupt of ['self','extra']){
      const f=await fixture();await f.flow.close();f.editSaved(s=>{s.renewal=corrupt==='self'?{requestId:s.requestId,secret:s.secret}:{requestId:crypto.randomUUID(),secret:s.secret,extra:true};});
      await expect(AppProtectedInstallationSignIn.open({...f.options,mode:'existing'})).rejects.toThrow();expect(f.requests).toHaveLength(0);
    }
  });
  it("failed durable commit cannot issue a new HTTP request",async()=>{
    const f=await fixture();vi.mocked(f.request).mockResolvedValueOnce(expiredReply());await expect(f.flow.start()).rejects.toMatchObject({reason:'expired'});f.setCommitFailure();
    await expect(f.flow.renewExpiredPairing()).rejects.toMatchObject({reason:'recovery_required'});expect(f.requests).toHaveLength(0);
  });
});
describe("default native fetch receiver", () => {
  it("uses the GlobalScope receiver and resumes the original protected request", async () => {
    const f = await fixture(), original = f.flow.view(); await f.flow.close();
    vi.stubGlobal("fetch", function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBe(globalThis);
      return f.request(input, init);
    });
    const flow = await AppProtectedInstallationSignIn.open({...f.options, fetch: undefined, mode: "existing"});
    expect(await flow.start()).toEqual(original); expect(f.requests).toHaveLength(1);
    await flow.close();
  });
});
describe("SDK-owned portal account confirmation", () => {
  const portalMetadata = (v: Record<string, unknown>) => { if ("account_id" in v) { v.account_email = "person@example.test"; v.account_selection_confirmed = true; } };
  it("protects authenticated email metadata then consumes only the current selection before native custody", async () => {
    const f = await fixture(); f.change(portalMetadata); f.setSelected();
    expect((await f.flow.exchange()).accountEmail).toBe("person@example.test");
    expect(JSON.stringify(f.read().selection)).toBe(JSON.stringify({accountId:account,connectorId:connector,challenge:"ab".repeat(32),approvalMode:"password-ak1",accountEmail:"person@example.test",portalConfirmed:true}));
    expect(() => f.flow.confirmedSelection()).toThrow("account_confirmation_required");
    expect((await f.flow.confirmPortalSelectedAccount()).state).toBe("account_confirmed");
    expect(f.flow.confirmedSelection().accountId).toBe(account);
    await f.flow.prepareOriginalDevice(f.installation); await f.flow.attest(f);
    expect((await f.flow.exchange()).state).toBe("awaiting_approval");
    expect(f.read().token).toBeNull(); // portal choice never implies final consent
    f.setApproved(); expect((await f.flow.exchange()).state).toBe("paired");
    expect(f.read().selection.accountId).toBe(account); expect(f.read().selection.accountEmail).toBe("person@example.test");
  });
  it("legacy selected receipts still need explicit confirmation; no email/id fallback", async () => {
    const f = await fixture(); f.setSelected(); await f.flow.exchange();
    expect(f.flow.view().accountEmail).toBeNull();
    await expect(f.flow.confirmPortalSelectedAccount()).rejects.toMatchObject({reason: "account_confirmation_required"});
    expect(f.runtime.signCpEnrol).not.toHaveBeenCalled(); expect(f.read().nativeStarted).toBe(false);
  });
  it.each(["no-marker"]) ("refuses %s without confirming/opening custody", async mode => {
    const f = await fixture(); f.setSelected(); f.change(v => {
      portalMetadata(v); if (!("account_id" in v)) return;
      if (mode === "no-email") delete v.account_email;
      if (mode === "no-marker") delete v.account_selection_confirmed;
      if (mode === "false-marker") v.account_selection_confirmed = false;
      if (mode === "bad-email") v.account_email = "not an email";
      if (mode === "email-control") v.account_email = "name\u0000@example.test";
    });
    await expect(f.flow.exchange()).rejects.toMatchObject({reason: "response"});
    expect(f.read().selection).toBeNull(); expect(f.read().confirmed).toBe(false); expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();
  });
  it("retains the exact portal selection across protected restore, never changes its account from metadata", async () => {
    const f = await fixture(); f.setSelected(); f.change(portalMetadata); await f.flow.exchange(); await f.flow.close();
    const reopened = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing"});
    expect((await reopened.confirmPortalSelectedAccount()).accountEmail).toBe("person@example.test");
    expect(reopened.confirmedSelection().accountId).toBe(account); await reopened.close();
  });
  it("refuses replacement account and withdrawn portal marker after selection", async () => {
    const f = await fixture(); f.setSelected(); f.change(portalMetadata); await f.flow.exchange();
    f.change(v => { portalMetadata(v); if ("account_id" in v) v.account_id = connector; });
    await expect(f.flow.exchange()).rejects.toMatchObject({reason: "binding"}); expect(f.read().selection.accountId).toBe(account);
    f.change(() => {}); await expect(f.flow.exchange()).rejects.toMatchObject({reason: "binding"}); expect(f.read().confirmed).toBe(false);
  });
});
describe("canonical no-email portal identity", () => {
  const provider = (v: Record<string, unknown>) => {if("account_id" in v) Object.assign(v,{account_email:null,account_provider:"github",account_login:"fixture-login",account_selection_confirmed:true});};
  it("confirms/restores canonical GitHub metadata while preserving original actor/custody/proof", async () => {
    const f=await fixture(), original=f.read(); f.change(provider); f.setSelected();
    expect(await f.flow.exchange()).toMatchObject({accountEmail:null,accountProvider:"github",accountLogin:"fixture-login",state:"account_selected"});
    expect(f.runtime.signCpEnrol).not.toHaveBeenCalled(); expect(f.read().nativeStarted).toBe(false);
    await f.flow.confirmPortalSelectedAccount(); await f.flow.prepareOriginalDevice(f.installation); await f.flow.attest(f); f.setApproved();
    expect((await f.flow.exchange()).state).toBe("paired"); const paired=f.read(); await f.flow.close();
    const reopened=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"});
    expect(reopened.view()).toMatchObject({accountEmail:null,accountProvider:"github",accountLogin:"fixture-login",state:"paired"});
    for(const key of ["requestId","installationId","deviceId","secret","appId","kind","origin","cpOrigin"]) expect(f.read()[key]).toEqual(original[key]);
    expect(f.read()).toEqual(paired); expect(reopened.confirmedSelection().accountId).toBe(account); await reopened.close();
  });
  it("freezes provider confirmation across subsequent replies",async()=>{
    const f=await fixture();f.change(provider);f.setSelected();await f.flow.exchange();const before=f.read();
    for(const mode of ["login","email","withdraw"]){f.change(v=>{provider(v);if(mode==="login")v.account_login="changed";if(mode==="email"){v.account_email="changed@example.test";delete v.account_provider;delete v.account_login;}if(mode==="withdraw"){delete v.account_email;delete v.account_provider;delete v.account_login;delete v.account_selection_confirmed;}});await expect(f.flow.exchange()).rejects.toMatchObject({reason:"binding"});expect(f.read()).toEqual(before);}
  });
  it.each(["control"])("refuses malformed %s identity before custody",async mode=>{
    const f=await fixture();f.setSelected();f.change(v=>{provider(v);if(mode==="provider")v.account_provider="password";if(mode==="login")delete v.account_login;if(mode==="email")v.account_email="person@example.test";if(mode==="marker")v.account_selection_confirmed=false;if(mode==="blank")v.account_login=" ";if(mode==="control")v.account_login="name\u0000";if(mode==="oversize")v.account_login="x".repeat(101);if(mode==="extra")v.name="body-name";});
    await expect(f.flow.exchange()).rejects.toMatchObject({reason:"response"});expect(f.read().selection).toBeNull();expect(f.read().confirmed).toBe(false);expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();
  });
  it.each(["extra"])("refuses malformed protected %s on restore without replacement",async mode=>{
    const f=await fixture();f.change(provider);f.setSelected();await f.flow.exchange();await f.flow.close();
    f.editSaved(s=>{const selected=s.selection as Record<string,unknown>;if(mode==="provider")selected.accountProvider="password";if(mode==="login")delete selected.accountLogin;if(mode==="email")selected.accountEmail="invented@example.test";if(mode==="marker")delete selected.portalConfirmed;if(mode==="extra")selected.name="not-authority";});
    const before=f.read(), calls=vi.mocked(f.request).mock.calls.length;await expect(AppProtectedInstallationSignIn.open({...f.options,mode:"existing"})).rejects.toMatchObject({reason:"response"});expect(f.read()).toEqual(before);expect(f.request).toHaveBeenCalledTimes(calls);
  });
  it("keeps no-email additive consent independent from the initial email and restores its original tuple",async()=>{
    const f=await paired();const original=f.read();consentStart(f);await f.flow.startCollectionConsent(f.installation);
    consentExchange(f,provider,true);expect(await f.flow.exchangeCollectionConsent(f.installation)).toMatchObject({accountEmail:null,accountProvider:"github",accountLogin:"fixture-login",accountSelectionConfirmed:true});
    expect(f.flow.view().accountEmail).toBeNull();
    const before=f.read();consentExchange(f,v=>{provider(v);v.account_login="changed";});await expect(f.flow.exchangeCollectionConsent(f.installation)).rejects.toMatchObject({reason:"binding"});expect(f.read()).toEqual(before);
    consentExchange(f,provider);await f.flow.exchangeCollectionConsent(f.installation);const saved=f.read();
    for(const key of ["selection","installationId","deviceId","token","proof"])expect(saved[key]).toEqual(original[key]);
    await f.flow.close();const reopened=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"});expect(reopened.collectionConsentView()).toMatchObject({accountEmail:null,accountProvider:"github",accountLogin:"fixture-login",state:"scope_updated"});expect(f.read()).toEqual(saved);await reopened.close();
  });
});
async function confirmed(f: Awaited<ReturnType<typeof fixture>>) { f.setSelected(); await f.flow.exchange(); await f.flow.confirmSelectedAccount(account); await f.flow.prepareOriginalDevice(f.installation); }
const collection = "44444444-4444-4444-8444-444444444444";
async function approvedCollection() {
  const f = await paired();
  consentStart(f); await f.flow.startCollectionConsent(f.installation);
  consentExchange(f); await f.flow.exchangeCollectionConsent(f.installation);
  return f;
}

describe("explicit approved collection rename", () => {
  it("captures trimmed input and uses the original credential once without changing protected identity", async () => {
    const f = await approvedCollection(), before = f.read();
    vi.mocked(f.request).mockImplementationOnce(async (input, init) => {
      expect(String(input)).toBe(`${cpOrigin}/v1/next/collections/${collection}/name`);
      expect(init).toMatchObject({method: "PATCH", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
      expect((init!.headers as Record<string,string>).authorization).toBe(`Bearer ${before.token}`);
      expect(JSON.parse(String(init!.body))).toEqual({display_name: "Research"});
      return new Response(JSON.stringify({collection_id: collection, display_name: "Research"}));
    });
    expect(await f.flow.renameApprovedCollection(f.installation, collection, "  Research  ")).toEqual({collectionId: collection, displayName: "Research"});
    expect(f.read()).toEqual(before);
  });
  it("rejects malformed raw input and unapproved IDs before HTTP", async () => {
    const f = await approvedCollection(), calls = vi.mocked(f.request).mock.calls.length;
    for (const name of ["\tResearch", "Research\u2028", "\ud800", "", "x".repeat(201)])
      await expect(f.flow.renameApprovedCollection(f.installation, collection, name)).rejects.toMatchObject({reason: "binding"});
    await expect(f.flow.renameApprovedCollection(f.installation, connector, "Research")).rejects.toMatchObject({reason: "refused"});
    expect(f.request).toHaveBeenCalledTimes(calls);
  });
  it("a lost response stays unknown with no replay on restore or catalog equality", async () => {
    const f = await approvedCollection(), before = f.read(), calls = vi.mocked(f.request).mock.calls.length;
    vi.mocked(f.request).mockRejectedValueOnce(Error("lost reply"));
    await expect(f.flow.renameApprovedCollection(f.installation, collection, "Research")).rejects.toMatchObject({reason: "outcome_unknown"});
    expect(f.request).toHaveBeenCalledTimes(calls + 1); expect(f.read()).toEqual(before);
    await f.flow.close();
    const reopened = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing"});
    expect(f.request).toHaveBeenCalledTimes(calls + 1); expect(reopened.view().collectionIds).toContain(collection);
    await reopened.close();
  });
  it.each(["wrong-id"])("refuses %s response without another request", async kind => {
    const f = await approvedCollection(), calls = vi.mocked(f.request).mock.calls.length;
    vi.mocked(f.request).mockResolvedValueOnce(new Response(JSON.stringify(kind === "denied" ? {error: {code: "forbidden"}} : {collection_id: kind === "wrong-id" ? connector : collection, display_name: kind === "different-name" ? "Other" : "Research", ...(kind === "extra-field" ? {token: "not-allowed"} : {})}), {status: kind === "denied" ? 403 : 200}));
    await expect(f.flow.renameApprovedCollection(f.installation, collection, "Research")).rejects.toMatchObject({reason: kind === "denied" ? "refused" : "response"});
    expect(f.request).toHaveBeenCalledTimes(calls + 1);
  });
  it("lost original installation fences before request and after an inflight response", async () => {
    const f = await approvedCollection(), calls = vi.mocked(f.request).mock.calls.length;
    const current = f.installation.isCurrent; f.installation.isCurrent = () => false;
    await expect(f.flow.renameApprovedCollection(f.installation, collection, "Research")).rejects.toMatchObject({reason: "fenced"});
    expect(f.request).toHaveBeenCalledTimes(calls); f.installation.isCurrent = current;
    vi.mocked(f.request).mockImplementationOnce(async () => { f.installation.isCurrent = () => false; return new Response(JSON.stringify({collection_id: collection, display_name: "Research"})); });
    await expect(f.flow.renameApprovedCollection(f.installation, collection, "Research")).rejects.toMatchObject({reason: "fenced"});
    expect(f.request).toHaveBeenCalledTimes(calls + 1);
  });
});
describe("explicit owner collection delete", () => {
  it("sends one DELETE with the trimmed confirmation and maps CP refusals to bounded codes", async () => {
    const f = await approvedCollection(), before = f.read();
    vi.mocked(f.request).mockImplementationOnce(async (input, init) => {
      expect(String(input)).toBe(`${cpOrigin}/v1/next/collections/${collection}`);
      expect(init).toMatchObject({method: "DELETE", credentials: "omit", redirect: "error", cache: "no-store"});
      expect((init!.headers as Record<string,string>).authorization).toBe(`Bearer ${before.token}`);
      expect(JSON.parse(String(init!.body))).toEqual({confirm_name: "Research"});
      return new Response(JSON.stringify({collection_id: collection, deleted: true}));
    });
    expect(await f.flow.deleteApprovedCollection(f.installation, collection, "  Research  ")).toEqual({collectionId: collection, deleted: true});
    const calls = vi.mocked(f.request).mock.calls.length;
    await expect(f.flow.deleteApprovedCollection(f.installation, connector, "Research")).rejects.toMatchObject({reason: "refused"});
    expect(f.request).toHaveBeenCalledTimes(calls);
    for (const [status, code, outcome] of [[409, "collection_name_mismatch", "collection_delete_name_mismatch"], [403, "not_owner", "collection_delete_not_owner"],
      [409, "migration_frozen", "collection_delete_frozen"], [404, "not_found", "collection_delete_not_found"], [403, "constructor", "collection_delete_failed"]] as const) {
      vi.mocked(f.request).mockResolvedValueOnce(new Response(JSON.stringify({error: {code, message: "server text"}}), {status}));
      const error = await f.flow.deleteApprovedCollection(f.installation, collection, "Research").catch((e: unknown) => e);
      expect(collectionDeleteError(error).code).toBe(outcome);
    }
    vi.mocked(f.request).mockResolvedValueOnce(new Response(JSON.stringify({collection_id: collection, deleted: false})));
    await expect(f.flow.deleteApprovedCollection(f.installation, collection, "Research")).rejects.toMatchObject({reason: "response"});
    vi.mocked(f.request).mockRejectedValueOnce(Error("lost reply"));
    expect(collectionDeleteError(await f.flow.deleteApprovedCollection(f.installation, collection, "Research").catch((e: unknown) => e)).code).toBe("collection_delete_outcome_unknown");
  });
});
async function paired(requestedCreateCollections = false) {
  const f = await fixture(requestedCreateCollections); await confirmed(f); await f.flow.attest(f); f.setApproved(); await f.flow.exchange(); return f;
}
function consentStart(f: Awaited<ReturnType<typeof fixture>>, lost = false) {
  vi.mocked(f.request).mockImplementationOnce(async (_input, init) => {
    const s = f.read(), r = s.consentRequest;
    expect(r).not.toBeNull(); expect(r.requestId).not.toBe(s.requestId); expect(r.secret).not.toBe(s.secret);
    expect(init).toMatchObject({method: "POST", credentials: "omit", redirect: "error"});
    expect((init!.headers as Record<string,string>).authorization).toBe(`Bearer ${s.token}`);
    expect(JSON.parse(String(init!.body))).toEqual({installation: {app_id: s.appId, request_id: r.requestId, pairing_secret: r.secret, installation_id: s.installationId, device_id: s.deviceId, kind: s.kind, requested_create_collections: r.requestedCreateCollections, reconsent: true}});
    if (lost) throw Error("lost consent start reply");
    return new Response(JSON.stringify({pairing_id: r.requestId, pairing_secret: r.secret, verification_uri: `${cpOrigin}/pair/${r.requestId}`, expires_in: 600, installation_device: true, app_id: s.appId, app_origin: origin, app_name: appName}));
  });
}
function consentExchange(f: Awaited<ReturnType<typeof fixture>>, change: (v: Record<string, unknown>) => void = () => {}, pending = false) {
  vi.mocked(f.request).mockImplementationOnce(async (input, init) => {
    const s = f.read(), r = s.consentRequest;
    expect(new URL(String(input)).pathname).toBe(`/v1/pairing-requests/${r.requestId}/exchange`);
    expect((init!.headers as Record<string,string>).authorization).toBe(`Bearer ${r.secret}`);
    expect(init!.body).toBeUndefined();
    const value = {status: pending ? "awaiting_approval" : "scope_updated", request_id: r.requestId, account_id: account, connector_id: connector, device_id: s.deviceId, installation_id: s.installationId, kind: s.kind, challenge: "cd".repeat(32), approval_mode: "password-ak1", app_id: s.appId, app_origin: origin, expires_at: Date.now() + 600000, ...(pending ? {} : {added_collection_ids: [collection], approved_create_collections: r.requestedCreateCollections})};
    change(value); return new Response(JSON.stringify(value), {status: pending ? 202 : 200});
  });
}
describe("original native timer consent receipts",()=>{
  const grantId="77777777-7777-4777-8777-777777777777",digest="ab".repeat(32);
  const publicGrant={grant_id:grantId,collection_id:collection,declaration_digest:digest};
  async function awaiting() {
    const f=await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved();
    f.change(v=>{if(v.status==="paired") Object.assign(v,{account_email:"owner@example.test",account_selection_confirmed:true,
      collection_ids:[collection],create_collections:false,selected_collection_id:collection,created_collection_ids:[],timer_consent:true,timer_grants:[publicGrant]});});
    return f;
  }
  it("protects original request/grant/declaration references before exposing them and restores without changing custody",async()=>{
    const f=await awaiting(),before=f.read(),view=await f.flow.exchange();
    const expected={requestId:view.requestId,approved:true,grants:[{grantId,collectionId:collection,declarationDigest:digest}]};
    expect(view.timerConsent).toEqual(expected); expect(f.read().timerConsent).toEqual(expected);
    expect(f.read().proof).toEqual(before.proof); expect(f.read().installationId).toBe(before.installationId);
    expect(Object.isFrozen(view.timerConsent)).toBe(true); expect(Object.isFrozen(view.timerConsent!.grants[0])).toBe(true);
    const session=f.flow.session("https://log.example.test"); expect(session.timerConsent!()).toEqual(expected);
    const saved=f.read(); await f.flow.close();
    const warm=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"}); expect(warm.view().timerConsent).toEqual(expected);
    expect(f.read()).toEqual(saved); await warm.close();
  });
  it.each(["register"] as const)("protects and restores original %s channel metadata without retaining target bytes or changing custody",async pending=>{
    const f=await awaiting();await f.flow.exchange();const original=f.read();
    const channel={grantId,kind:"fcm" as const,targetDigest:"cd".repeat(32),channelId:pending==="register"?null:connector,pending};
    await f.flow.retainTimerChannel(grantId,channel);expect(f.flow.originalTimerChannel(grantId)).toEqual(channel);
    for(const key of ["proof","deviceId","installationId","token","version"])expect(f.read()[key]).toEqual(original[key]);
    expect("timerChannel" in f.flow.view()).toBe(false);expect(new TextEncoder().encode(JSON.stringify(f.read())).length).toBeLessThan(128*1024);
    await f.flow.close();const warm=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"});expect(warm.originalTimerChannel(grantId)).toEqual(channel);await warm.close();
  });
  it("channel journal never grants a foreign reference and older unknown metadata cannot leak into a fresh approval",async()=>{
    const f=await awaiting();await f.flow.exchange();
    const channel={grantId,kind:"web_push" as const,targetDigest:"cd".repeat(32),channelId:connector,pending:null};
    await expect(f.flow.retainTimerChannel(account,channel)).rejects.toMatchObject({reason:"fenced"});expect(f.read().timerChannel).toBeUndefined();
    await f.flow.retainTimerChannel(grantId,channel);await f.flow.close();
    f.editSaved(s=>{(s.timerChannel as Record<string,unknown>).grantId=account;});
    const warm=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"});expect(warm.originalTimerChannel(grantId)).toBeNull();expect(()=>warm.originalTimerChannel(account)).toThrow("fenced");await warm.close();
  });
  it.each(["target_bytes"])("refuses malformed protected channel %s instead of resetting original stores",async defect=>{
    const f=await awaiting();await f.flow.exchange();await f.flow.close();f.editSaved(s=>{
      const channel:Record<string,unknown>={grantId,kind:"fcm",targetDigest:"cd".repeat(32),channelId:connector,pending:null};
      if(defect==="target_bytes")channel.token="never persist payload";
      if(defect==="incomplete_delete"){channel.channelId=null;channel.pending="delete";}
      if(defect==="bad_digest")channel.targetDigest="not a digest";
      s.timerChannel=channel;
    });const saved=f.read();await expect(AppProtectedInstallationSignIn.open({...f.options,mode:"existing"})).rejects.toMatchObject({reason:"recovery_required"});expect(f.read()).toEqual(saved);
  });
  it("bounds 1000 public references on the wire but retains only the original chosen grant within the unchanged protected store budget",async()=>{
    const f=await awaiting();
    const references=Array.from({length:999},(_,i)=>({grant_id:`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,collection_id:`00000000-0000-4000-9000-${String(i+1).padStart(12,"0")}`,declaration_digest:digest}));
    f.change(v=>{if(v.status==="paired") Object.assign(v,{account_email:"owner@example.test",account_selection_confirmed:true,
      collection_ids:[collection,...references.map(grant=>grant.collection_id)],create_collections:false,selected_collection_id:collection,created_collection_ids:[],timer_consent:true,timer_grants:[publicGrant,...references]});});
    expect((await f.flow.exchange()).timerConsent?.grants).toEqual([{grantId,collectionId:collection,declarationDigest:digest}]);
    expect(new TextEncoder().encode(JSON.stringify(f.read())).length).toBeLessThan(128*1024); await f.flow.close();
  });
  it.each([false])("decline/omission %s completes original pairing without fabricating timer authority",async choice=>{
    const f=await awaiting(); f.change(v=>{if(v.status==="paired") Object.assign(v,{collection_ids:[collection],create_collections:false,timer_consent:choice,timer_grants:[]});});
    expect((await f.flow.exchange()).state).toBe("paired");
    expect(f.flow.session("https://log.example.test").timerConsent!()).toEqual(choice===false?{requestId:f.read().requestId,approved:false,grants:[]}:null);
    await f.flow.close();
  });
  it.each(["missing_confirmation","foreign_scope"])("rejects %s receipt before protecting a credential",async defect=>{
    const f=await awaiting(),original=f.read();
    f.change(v=>{if(v.status!=="paired") return;
      Object.assign(v,{account_email:"owner@example.test",account_selection_confirmed:true,collection_ids:[collection],create_collections:false,selected_collection_id:collection,created_collection_ids:[],timer_consent:true,timer_grants:[{...publicGrant}]});
      if(defect==="partial") delete v.timer_grants;
      if(defect==="missing_confirmation") {delete v.account_email;delete v.account_selection_confirmed;}
      if(defect==="missing_choice") {delete v.selected_collection_id;delete v.created_collection_ids;}
      if(defect==="foreign_scope") v.timer_grants=[{...publicGrant,collection_id:account}];
      if(defect==="duplicate_grant") v.timer_grants=[publicGrant,publicGrant];
      if(defect==="duplicate_collection") v.timer_grants=[publicGrant,{...publicGrant,grant_id:connector}];
      if(defect==="invalid_digest") v.timer_grants=[{...publicGrant,declaration_digest:digest.toUpperCase()}];
      if(defect==="drift_digest") {v.collection_ids=[collection,account];v.timer_grants=[publicGrant,{grant_id:connector,collection_id:account,declaration_digest:"cd".repeat(32)}];}
      if(defect==="data") v.timer_grants=[{...publicGrant,data:"not receipt metadata"}];
    });
    await expect(f.flow.exchange()).rejects.toMatchObject({reason:"response"}); expect(f.read()).toEqual(original); await f.flow.close();
  });
  it("omitted later reconsent retains only ORIGINAL timer references; false withdraws and true adopts only fresh IDs",async()=>{
    const f=await awaiting(); await f.flow.exchange(); const original=f.flow.view().timerConsent!,session=f.flow.session("https://log.example.test"),custody=f.read().proof,token=f.read().token;
    const pending={grantId,kind:"fcm" as const,targetDigest:"cd".repeat(32),channelId:null,pending:"register" as const};await f.flow.retainTimerChannel(grantId,pending);
    const complete=async(choice:boolean|null,newGrant=grantId)=>{
      consentStart(f); await f.flow.startCollectionConsent(f.installation);
      consentExchange(f,v=>{Object.assign(v,{account_email:"owner@example.test",account_selection_confirmed:true,selected_collection_id:collection,created_collection_ids:[],timer_consent:choice,timer_grants:choice===true?[{...publicGrant,grant_id:newGrant}]:[]});});
      return f.flow.exchangeCollectionConsent(f.installation);
    };
    await complete(null); expect(session.timerConsent!()).toEqual(original);
    const saved=f.read(); await f.flow.close(); const warm=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"});
    expect(warm.view().timerConsent).toEqual(original); expect(f.read()).toEqual(saved); await warm.close();
    // Reopen the same store/actor; only explicit fresh consent changes references.
    const resumed=await AppProtectedInstallationSignIn.open({...f.options,mode:"existing"}); f.flow=resumed;
    await complete(false); expect(resumed.view().timerConsent).toMatchObject({approved:false,grants:[]});expect(()=>resumed.originalTimerChannel(grantId)).toThrow("fenced");
    const fresh="88888888-8888-4888-8888-888888888888"; await complete(true,fresh);
    expect(resumed.view().timerConsent?.grants).toEqual([{grantId:fresh,collectionId:collection,declarationDigest:digest}]);expect(resumed.originalTimerChannel(fresh)).toBeNull();expect(f.read().timerChannel).toEqual(pending); expect(f.read().proof).toEqual(custody); expect(f.read().token).toBe(token); await resumed.close();
  });
});
describe("portal collection choice and creation provenance", () => {
  it("protects exact approved initial choice/creation metadata and restores it without inferring readiness", async () => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved();
    f.change(v => { if (v.status === "paired") {v.collection_ids = [collection]; v.create_collections = false; v.selected_collection_id = collection; v.created_collection_ids = [collection];} });
    const view = await f.flow.exchange(); expect(view.collectionSelection).toEqual({requestId: view.requestId, selectedCollectionId: collection, createdCollectionIds: [collection]});
    expect(() => (view.collectionSelection!.createdCollectionIds as string[]).push(account)).toThrow(); await f.flow.close();
    const reopened = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing"}); expect(reopened.view().collectionSelection).toEqual(view.collectionSelection); await reopened.close();
  });
  it.each(["unapproved-choice"]) ("refuses %s before protecting credential/metadata", async mode => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved();
    f.change(v => {v.collection_ids = [collection]; v.create_collections = false; v.selected_collection_id = collection; v.created_collection_ids = [collection];
      if (mode === "unapproved-choice") v.selected_collection_id = connector;
      if (mode === "unapproved-creation") v.created_collection_ids = [connector];
      if (mode === "duplicate-creation") v.created_collection_ids = [collection, collection];
      if (mode === "missing-choice") delete v.selected_collection_id;
      if (mode === "missing-creations") delete v.created_collection_ids;
    });
    await expect(f.flow.exchange()).rejects.toMatchObject({reason: "response"}); expect(f.read().token).toBeNull(); expect(f.read().collectionSelection).toBeUndefined();
  });
});
describe("protected installation lifecycle (stand-in store/CP/native, actual randomness)", () => {
  it("commits original secret/tuple before START; public view excludes capabilities", async () => {
    const f = await fixture(); const v = await f.flow.start(); expect(f.trace[0]).toBe("protected-original"); expect(f.trace[1]).toBe("http");
    expect(v.state).toBe("pending"); expect(Object.keys(v)).not.toContain("secret"); expect(Object.keys(v)).not.toContain("token"); expect(f.read().secret).toMatch(/^pair_[A-Za-z0-9_-]{43}$/);
    const a = f.read(); await f.flow.start(); expect(f.read()).toEqual(a); expect(f.requests[0]!.body).toEqual(f.requests[1]!.body); await f.flow.close();
  });
  it("protects same native pending/proof before attest, credential/receipt before native ACK", async () => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved(); await f.flow.exchange(); await f.flow.acknowledge(f);
    expect(f.trace.indexOf("protected-noise-pending")).toBeLessThan(f.trace.indexOf("native-fixed-sign"));
    expect(f.trace.at(-2)).toBe("protected-receipt"); expect(f.trace.at(-1)).toBe("native-ack"); expect(f.flow.view().state).toBe("paired");
    const session = f.flow.session("https://log.example.test"); expect(await session.connectorBearer({signal: f.options.signal})).toBe(f.read().token);
    await f.flow.close(); expect(session.isCurrent()).toBe(false); await expect(session.connectorBearer({signal: f.options.signal})).rejects.toThrow("fenced");
  });
  it("pending host session binds confirmed account/environment but refuses credential authority before completion", async () => {
    const f = await fixture();
    expect(() => f.flow.confirmedHostSession("https://log.example.test", "lab")).toThrow("account_confirmation_required");
    await confirmed(f);
    expect(() => f.flow.confirmedHostSession("https://log.example.test", "production")).toThrow("binding");
    const session = f.flow.confirmedHostSession("https://log.example.test", "lab");
    expect(session.accountId).toBe(account); expect(session.isCurrent()).toBe(true);
    await expect(session.connectorBearer({signal: f.options.signal})).rejects.toThrow("fenced");
    expect(() => f.flow.session("https://log.example.test")).toThrow("binding");
    await f.flow.attest(f); f.setApproved(); await f.flow.exchange();
    expect(await session.connectorBearer({signal: f.options.signal})).toBe(f.read().token);
    await f.flow.close(); expect(session.isCurrent()).toBe(false);
  });
  it("restores completed original tuple+credential before HTTP; no automatic registration/re-sign", async () => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved(); await f.flow.exchange(); const original = f.flow.view(), token = f.read().token; await f.flow.close();
    const warm = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing"}); const count = f.requests.length;
    expect(await warm.start()).toEqual(original); expect(await warm.exchange()).toEqual(original); expect(f.requests.length).toBe(count);
    expect(await warm.session("https://log.example.test").connectorBearer({signal: f.options.signal})).toBe(token); await warm.close();
  });
  it("missing-existing/fresh-existing do not create replacements", async () => {
    const f = await fixture(); const original = f.read(); await f.flow.close(); await expect(AppProtectedInstallationSignIn.open(f.options)).rejects.toThrow("recovery_required"); expect(f.read()).toEqual(original);
  });
  it("records original native attempt before keys; interrupted attempt can only restore existing", async () => {
    const f = await fixture(); f.setSelected(); await f.flow.exchange(); await f.flow.confirmSelectedAccount(account);
    const first = await f.flow.prepareOriginalDevice(f.installation); expect(first.mode).toBe("fresh"); expect(first.pin.installationOwned()).toBe(true); expect(f.read().nativeStarted).toBe(true);
    const second = await f.flow.prepareOriginalDevice(f.installation); expect(second.mode).toBe("existing");
    f.installation.isCurrent = () => true; expect(first.pin.isCurrent()).toBe(false);
    await f.flow.close(); const warm = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing"}); expect((await warm.prepareOriginalDevice(f.installation)).mode).toBe("existing"); await warm.close();
  });
  it("lost START HTTP repeats exact request only, does not reset protected operation", async () => {
    const f = await fixture(), original = f.read(); f.setFailHttp(); await expect(f.flow.start()).rejects.toThrow("outcome_unknown"); await expect(f.flow.start()).rejects.toThrow("outcome_unknown"); expect(f.read()).toEqual(original); expect(f.requests[0]!.body).toEqual(f.requests[1]!.body);
  });
  it("lost proof HTTP does not sign a second time and preserves original actor", async () => {
    const f = await fixture(); await confirmed(f); f.setFailHttp(); await expect(f.flow.attest(f)).rejects.toThrow("outcome_unknown"); const proof = f.read().proof;
    await expect(f.flow.attest(f)).rejects.toThrow("outcome_unknown"); expect(f.runtime.signCpEnrol).toHaveBeenCalledTimes(1); expect(f.read().proof).toEqual(proof);
  });
  it("lost protected completion fences before native ACK, preserves committed tuple", async () => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved(); f.setCommitFailure(); await expect(f.flow.exchange()).rejects.toThrow("recovery_required"); expect(f.read().token).toMatch(/^idev_/); expect(f.runtime.acknowledgeDeviceRegistration).not.toHaveBeenCalled(); expect(f.flow.isCurrent()).toBe(false);
  });
  it("requires actual installation ownership, not account selection alone", async () => {
    const f = await fixture(); await confirmed(f); f.installation.isCurrent = () => false; await expect(f.flow.attest(f)).rejects.toThrow("fenced"); expect(f.persistence.pending).not.toHaveBeenCalled(); expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();
  });
  it.each(["account_id"]) ("changed authenticated %s cannot replace selected original", async field => {
    const f = await fixture(); f.setSelected(); await f.flow.exchange(); const original = f.read(); f.change(v => {v[field] = field.endsWith("_id") ? "33333333-3333-4333-8333-333333333333" : "changed";}); await expect(f.flow.exchange()).rejects.toThrow(); expect(f.read()).toEqual(original);
  });
  it("foreign verification URI / echoed secret and oversized body refuse", async () => {
    const f = await fixture(); f.change(v => {v.verification_uri = "https://foreign.test/pair";}); await expect(f.flow.start()).rejects.toThrow("response"); f.change(v => {v.pairing_secret = "pair_wrong";}); await expect(f.flow.start()).rejects.toThrow("response"); f.setOversized(); await expect(f.flow.start()).rejects.toThrow("response");
  });
  it("changed registration key refuses without persisting a credential", async () => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved(); f.change(v => {(v.registration as Record<string, unknown>).noise_pk = "00".repeat(32);}); await expect(f.flow.exchange()).rejects.toThrow("binding"); expect(f.read().token).toBeNull();
  });
  it("parent abort closes origin ledger and fences stale callbacks", async () => {
    const f = await fixture(), parent = new AbortController(); await f.flow.close(); const flow = await AppProtectedInstallationSignIn.open({...f.options, signal: parent.signal, mode: "existing"}); parent.abort(); expect(flow.isCurrent()).toBe(false); expect(() => flow.view()).toThrow("fenced");
  });
  it("defaults persisted create request false; explicit true survives restore and cannot be changed", async () => {
    const f = await fixture(true); expect(f.read().requestedCreateCollections).toBe(true); await f.flow.start(); await f.flow.close();
    await expect(AppProtectedInstallationSignIn.open({...f.options, mode: "existing", requestedCreateCollections: false})).rejects.toThrow("binding");
    const warm = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing", requestedCreateCollections: undefined}); expect(warm.view().requestedCreateCollections).toBe(true); await warm.close();
  });
  it("pre-C5 receipt has empty scope rather than compatibility access", async () => {
    const f = await paired(); expect(f.flow.view()).toMatchObject({collectionIds: [], createCollections: false});
  });
  it.each(["duplicate", "unsolicited_create"])("refuses malformed initial scope %s before protecting token", async shape => {
    const f = await fixture(); await confirmed(f); await f.flow.attest(f); f.setApproved(); f.change(v => {
      v.collection_ids = shape === "duplicate" ? [collection, collection] : shape === "null" ? null : [collection];
      if (shape !== "partial") v.create_collections = shape === "unsolicited_create";
    });
    await expect(f.flow.exchange()).rejects.toThrow("response"); expect(f.read().token).toBeNull();
  });
  it("additive consent protects new request, retains original actor/token/proof, performs no new native sign/ACK", async () => {
    const f = await paired(), before = f.read(), signs = vi.mocked(f.runtime.signCpEnrol).mock.calls.length;
    consentStart(f); const view = await f.flow.startCollectionConsent(f.installation, true); expect(view.state).toBe("pending"); expect(Object.keys(view)).not.toContain("secret");
    consentExchange(f, () => {}, true); await f.flow.exchangeCollectionConsent(f.installation);
    consentExchange(f); await f.flow.exchangeCollectionConsent(f.installation);
    expect(f.flow.view()).toMatchObject({collectionIds: [collection], createCollections: true});
    const after = f.read(); for (const field of ["token", "proof", "requestId", "secret", "installationId", "deviceId", "selection"]) expect(after[field]).toEqual(before[field]);
    expect(f.runtime.signCpEnrol).toHaveBeenCalledTimes(signs); expect(f.runtime.acknowledgeDeviceRegistration).not.toHaveBeenCalled();
    const calls = vi.mocked(f.request).mock.calls.length; await f.flow.exchangeCollectionConsent(f.installation); expect(vi.mocked(f.request).mock.calls.length).toBe(calls);
    await f.flow.close(); const warm = await AppProtectedInstallationSignIn.open({...f.options, mode: "existing"}); expect(warm.collectionConsentView()?.state).toBe("scope_updated"); expect(warm.view().createCollections).toBe(true); await warm.close();
  });
  it("unknown consent START retains exact child nonce/secret and original bearer for explicit repeat", async () => {
    const f = await paired(); consentStart(f, true); await expect(f.flow.startCollectionConsent(f.installation, true)).rejects.toThrow("outcome_unknown"); const before = f.read();
    consentStart(f); await f.flow.startCollectionConsent(f.installation, true); expect(f.read()).toEqual(before);
    await expect(f.flow.startCollectionConsent(f.installation, false)).rejects.toThrow("binding");
  });
  it.each(["account_id", "token"])("refuses changed/replacement consent %s without altering original scope/actor", async field => {
    const f = await paired(); consentStart(f); await f.flow.startCollectionConsent(f.installation);
    consentExchange(f, () => {}, true); await f.flow.exchangeCollectionConsent(f.installation); const before = f.read();
    consentExchange(f, v => {v[field] = field === "challenge" ? "ef".repeat(32) : "changed";}); await expect(f.flow.exchangeCollectionConsent(f.installation)).rejects.toThrow(); expect(f.read()).toEqual(before);
  });
  it("no ownership or replacement ownership callback fences consent before effects/commit", async () => {
    const f = await paired(); f.installation.isCurrent = () => false; const calls = vi.mocked(f.request).mock.calls.length;
    await expect(f.flow.startCollectionConsent(f.installation)).rejects.toThrow("fenced"); expect(vi.mocked(f.request).mock.calls.length).toBe(calls); expect(f.read().consentRequest).toBeNull();
    f.installation.isCurrent = () => true; consentStart(f); await f.flow.startCollectionConsent(f.installation); const before = f.read();
    consentExchange(f, () => {f.installation.isCurrent = () => true;}); await expect(f.flow.exchangeCollectionConsent(f.installation)).rejects.toThrow("fenced"); expect(f.read()).toEqual(before);
  });
  it("reads fresh scoped metadata with original credential without adding local grants", async () => {
    const f = await paired(), before = f.read(); vi.mocked(f.request).mockImplementationOnce(async (input, init) => {
      expect(String(input)).toBe(`${cpOrigin}/v1/next/collections`); expect(init).toMatchObject({method: "GET", credentials: "omit", redirect: "error"}); expect((init!.headers as Record<string,string>).authorization).toBe(`Bearer ${before.token}`);
      return new Response(JSON.stringify({collections: [{collection_id: collection, display_name: "Tasks", role: "editor"}]}));
    });
    expect(await f.flow.listApprovedCollections(f.installation)).toEqual([{collectionId: collection, displayName: "Tasks", role: "editor"}]); expect(f.read()).toEqual(before);
  });
  it("carries a listed collection's availability, strictly parsed; absent means available", async () => {
    const f = await paired(), ids = ["0b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e10", "1b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e11", "2b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e12"];
    vi.mocked(f.request).mockImplementationOnce(async () => new Response(JSON.stringify({collections: [
      {collection_id: collection, display_name: "Tasks", role: "editor"},
      {collection_id: ids[0], display_name: "Moving", role: "owner", availability: {state: "unavailable", reason: "collection_migrating"}},
      {collection_id: ids[1], display_name: "Odd", role: "owner", availability: {state: "unavailable", reason: "something_new"}},
      {collection_id: ids[2], display_name: "Gone", role: "viewer", availability: {state: "unavailable", reason: "collection_deleted"}},
    ]})));
    const listed = await f.flow.listApprovedCollections(f.installation);
    expect(listed[0]).toEqual({collectionId: collection, displayName: "Tasks", role: "editor"});
    expect(listed.map(c => c.availability)).toEqual([undefined, {state: "unavailable", reason: "collection_migrating"}, {state: "unavailable", reason: "device_offline"}, {state: "unavailable", reason: "collection_deleted"}]);
    expect(describeError(listed[3])?.title).toBe("Collection deleted");
    expect(describeError(listed[1])?.key).toBe("collection_migrating");
    // Only the availability key is new; anything else still refuses the response.
    vi.mocked(f.request).mockImplementationOnce(async () => new Response(JSON.stringify({collections: [{collection_id: collection, display_name: "Tasks", role: "editor", ready: true}]})));
    await expect(f.flow.listApprovedCollections(f.installation)).rejects.toThrow("response");
  });
  it("invalid registry identifier/name refuses before opening pre-account storage", async () => {
    const f = await fixture(), count = vi.mocked(AppInstallationStore.open).mock.calls.length;
    for (const appId of ["", "a".repeat(65), "app/id", " app", "__proto__\n"]) await expect(AppProtectedInstallationSignIn.open({...f.options, appId})).rejects.toThrow("binding");
    for (const appName of ["", " name ", "a".repeat(101)]) await expect(AppProtectedInstallationSignIn.open({...f.options, appName})).rejects.toThrow("binding");
    expect(vi.mocked(AppInstallationStore.open).mock.calls.length).toBe(count);
  });
  it("preserves original app/environment binding across a reopened generic installation", async () => {
    const f = await fixture(), original = f.read(); await f.flow.close();
    for (const changed of [{appId: "another-app"}, {environment: "production" as const}, {origin: "https://another.example.test"}]) {
      await expect(AppProtectedInstallationSignIn.open({...f.options, mode: "existing", ...changed})).rejects.toThrow("recovery_required");
      expect(f.read()).toEqual(original); expect(f.requests).toHaveLength(0);
    }
  });
  it.each(["app_origin"])("rejects CP START %s drift for a generic app", async field => {
    const f = await fixture(); f.change(v => { v[field] = "foreign"; });
    await expect(f.flow.start()).rejects.toThrow("response"); expect(f.read().token).toBeNull();
  });
  it("rejects a different CP connector name without saving its credential", async () => {
    const f = await fixture(); await f.flow.start(); f.setSelected(); await f.flow.exchange(); await f.flow.confirmSelectedAccount(account);
    await f.flow.prepareOriginalDevice(f.installation); await f.flow.attest(f); f.setApproved();
    f.change(v => { if (v.connector) (v.connector as Record<string, unknown>).name = "Another app"; });
    await expect(f.flow.exchange()).rejects.toThrow("binding"); expect(f.read().token).toBeNull();
  });
});
describe("transient collection hint on START", () => {
  const hint = "77777777-7777-4777-8777-777777777777";
  it("sends the hint beside the original request and opens the exact returned URI; a CP without hint support keeps the plain URI", async () => {
    const f = await fixture(); f.change(v => {v.verification_uri = `${v.verification_uri}?collection_hint=${hint}`;});
    const view = await f.flow.start({collectionHint: hint});
    expect((f.requests[0]!.body as Record<string, unknown>).collection_hint).toBe(hint); expect(view.verificationUri).toBe(`${cpOrigin}/pair/${view.requestId}?collection_hint=${hint}`);
    expect(f.read()).not.toHaveProperty("collectionHint"); expect(f.flow.view().verificationUri).toBe(`${cpOrigin}/pair/${view.requestId}`);
    f.change(() => {}); expect((await f.flow.start({collectionHint: hint})).verificationUri).toBe(`${cpOrigin}/pair/${view.requestId}`);
  });
  it("refuses a returned URI carrying any other hint, and a non-canonical hint before HTTP", async () => {
    const f = await fixture(); f.change(v => {v.verification_uri = `${v.verification_uri}?collection_hint=${hint}`;});
    await expect(f.flow.start()).rejects.toThrow("response"); await expect(f.flow.start({collectionHint: "AAAAAAAA-7777-4777-8777-777777777777"})).rejects.toMatchObject({reason: "binding"}); expect(f.requests).toHaveLength(1);
  });
});
