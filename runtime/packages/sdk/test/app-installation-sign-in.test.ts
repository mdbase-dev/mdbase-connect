import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProtectedInstallationSignIn } from "../src/app-host/installation-sign-in.js";
import { AppInstallationStore } from "../src/app-host/installation-store.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
const origin = "https://lab.tasknotes-app.pages.dev", cpOrigin = "https://cp.example.test";
const account = "11111111-1111-4111-8111-111111111111", connector = "22222222-2222-4222-8222-222222222222";
const pk = {signPublicKey: new Uint8Array(32).fill(3), kemPublicKey: new Uint8Array(32).fill(4), noisePublicKey: new Uint8Array(32).fill(5)};
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(requestedCreateCollections = false) {
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
      value = {pairing_id: state.requestId, pairing_secret: state.secret, verification_uri: `${cpOrigin}/pair/${state.requestId}`, expires_in: 600, installation_device: true, app_id: state.appId, app_origin: state.origin, app_name: "TaskNotes"};
    } else {
      expect(bearer).toBe(`Bearer ${state.secret}`);
      if (path.endsWith("/attest")) { expect(body).toEqual(state.proof); expect(trace).toContain("protected-commit"); value = {ok: true}; }
      else if (!selected) {status = 202; value = {status: "pending"};}
      else if (!state.proof) {status = 202; value = {status: "account_selected", ...selection};}
      else if (!approved) {status = 202; value = {status: "awaiting_approval", ...selection};}
      else value = {status: "paired", ...selection, connector: {id: connector, name: "TaskNotes"}, token: `idev_${"a".repeat(43)}`, registration: {device_id: state.deviceId, sign_pk: hex(pk.signPublicKey), kem_pk: hex(pk.kemPublicKey), noise_pk: hex(pk.noisePublicKey)}};
    }
    change(value); if (oversized) value = {padding: "a".repeat(65537)};
    return new Response(JSON.stringify(value), {status});
  }) as unknown as typeof fetch;
  const options = {origin, cpOrigin, appId: "tasknotes-web" as const, environment: "lab" as const, mode: "fresh" as "fresh" | "existing", signal: new AbortController().signal, locks: undefined, fetch: request, requestedCreateCollections};
  const flow = await AppProtectedInstallationSignIn.open(options);
  const installation = {scope: {account, installation: flow.view().installationId}, isCurrent: () => true};
  const custody = {...pk, envelope: new Uint8Array([6, 7])};
  const runtime = {deviceCustodyCurrent: (_pin: unknown, c: unknown) => c === custody, signCpEnrol: vi.fn(() => {trace.push("native-fixed-sign"); return {...pk, signature: new Uint8Array(64).fill(8)};}), acknowledgeDeviceRegistration: vi.fn(() => {trace.push("native-ack"); expect(read().token).toMatch(/^idev_/);})} as unknown as AppWasmRuntime;
  const persistence = {pending: vi.fn(async () => {trace.push("protected-noise-pending");}), registered: vi.fn(async () => {trace.push("protected-receipt");})};
  return {flow, options, installation, custody, runtime, persistence, trace, requests, read, request, editSaved:(change:(s:Record<string,unknown>)=>void)=>{const s=read();change(s);saved=new TextEncoder().encode(JSON.stringify(s));}, setSelected: () => {selected = true;}, setApproved: () => {approved = true;}, setFailHttp: () => {failHttp = true;}, setCommitFailure: () => {commitFailure = true;}, setOversized: () => {oversized = true;}, change: (fn: typeof change) => {change = fn;}};
}
const expiredReply = () => new Response(JSON.stringify({error:{code:"installation_pairing_expired",message:"expired"}}),{status:404});
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
  it.each(['installation_pairing_not_found','other',null])("does not authorize retry from arbitrary404 %s",async code=>{
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
  it.each(['close','abort','failed-commit'] as const)("%s clears retained RAM parent capability without deleting the durable successor",async mode=>{
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
  it.each([1,2])("opens protected v%s without inventing a renewal parent",async version=>{
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
  it.each(["wrong-id", "extra-field", "different-name", "denied"])("refuses %s response without another request", async kind => {
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
    return new Response(JSON.stringify({pairing_id: r.requestId, pairing_secret: r.secret, verification_uri: `${cpOrigin}/pair/${r.requestId}`, expires_in: 600, installation_device: true, app_id: s.appId, app_origin: origin, app_name: "TaskNotes"}));
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
describe("protected installation lifecycle (stand-in store/CP/native, actual randomness)", () => {
  it("commits original secret/tuple before START; public view excludes capabilities", async () => {
    const f = await fixture(); const v = await f.flow.start(); expect(f.trace[0]).toBe("protected-original"); expect(f.trace[1]).toBe("http");
    expect(v.state).toBe("pending"); expect(Object.keys(v)).not.toContain("secret"); expect(Object.keys(v)).not.toContain("token"); expect(f.read().secret).toMatch(/^pair_[A-Za-z0-9_-]{43}$/);
    const a = f.read(); await f.flow.start(); expect(f.read()).toEqual(a); expect(f.requests[0]!.body).toEqual(f.requests[1]!.body); await f.flow.close();
  });
  it("requires visible exact account confirmation before native/custody", async () => {
    const f = await fixture(); expect(() => f.flow.confirmedSelection()).toThrow("account_confirmation_required"); f.setSelected(); await f.flow.exchange();
    expect(f.flow.view().accountId).toBe(account); expect(() => f.flow.confirmedSelection()).toThrow("account_confirmation_required");
    await expect(f.flow.confirmSelectedAccount(connector)).rejects.toThrow("binding"); expect(f.read().confirmed).toBe(false);
    await f.flow.confirmSelectedAccount(account); expect(f.flow.confirmedSelection().accountId).toBe(account); expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();
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
  it("fences replacement ownership callback during pending persistence", async () => {
    const f = await fixture(); await confirmed(f); f.persistence.pending.mockImplementation(async () => {f.installation.isCurrent = () => true;}); await expect(f.flow.attest(f)).rejects.toThrow("fenced"); expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();
  });
  it.each(["request_id", "account_id", "connector_id", "device_id", "installation_id", "challenge", "kind", "app_id", "app_origin", "approval_mode"]) ("changed authenticated %s cannot replace selected original", async field => {
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
  it("persists approved initial IDs and requested create capability with original credential", async () => {
    const f = await fixture(true); await confirmed(f); await f.flow.attest(f); f.setApproved(); f.change(v => {v.collection_ids = [collection]; v.create_collections = true;});
    await f.flow.exchange(); expect(f.flow.view()).toMatchObject({collectionIds: [collection], createCollections: true}); expect(f.read().collectionIds).toEqual([collection]);
    expect(() => (f.flow.view().collectionIds as string[]).push(connector)).toThrow();
  });
  it.each(["partial", "duplicate", "null", "unsolicited_create"])("refuses malformed initial scope %s before protecting token", async shape => {
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
  it.each(["account_id", "connector_id", "device_id", "installation_id", "app_id", "app_origin", "kind", "request_id", "approval_mode", "challenge", "token", "registration"])("refuses changed/replacement consent %s without altering original scope/actor", async field => {
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
  it("mobile or environment-origin mismatch refuses before opening pre-account storage", async () => {
    const f = await fixture(), count = vi.mocked(AppInstallationStore.open).mock.calls.length;
    await expect(AppProtectedInstallationSignIn.open({...f.options, appId: "tasknotes-mobile"})).rejects.toThrow("binding"); await expect(AppProtectedInstallationSignIn.open({...f.options, environment: "production"})).rejects.toThrow("binding"); expect(vi.mocked(AppInstallationStore.open).mock.calls.length).toBe(count);
  });
});
