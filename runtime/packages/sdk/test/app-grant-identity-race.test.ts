// Source-only custody regression: scripted CP, in-memory grant store and fake
// relay/Noise responder. No browser, external network, native daemon or assets.
import { afterEach, expect, it, vi } from "vitest";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import { MdbaseAppGrants, memoryAppGrantStore } from "../src/app-grant/index.js";
import type { MdbaseApplicationDeclaration } from "../src/application/declaration.js";
import * as trust from "../src/application/packaged-trust.js";
import { encode, toHex } from "../src/cbor.js";
import {inheritOriginalAppGrant} from "../src/transport/original-session.js";
import type {MdbaseClient} from "../src/client.js";
import type {Session} from "../src/session.js";
import { uuidToBytes } from "../src/codec.js";
import { clientPrologue, generateKeyPair, IkResponder } from "../src/transport/noise.js";
import type { WebSocketLike } from "../src/transport/noise-session.js";

const CP = "https://cp.example.test";
const ORIGIN = "http://127.0.0.1:48218";
const APP = "5cdfa020-c201-4da8-845a-f2cc9969eade";
const COLLECTION = "0b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e10";
const DEVICE = "b0000000-0000-4000-8000-000000000001";
const GRANTS = ["c0000000-0000-4000-8000-000000000001", "c0000000-0000-4000-8000-000000000002"];
const fromB64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(o: { revokePrior?: boolean; expiresIn?: number } = {}) {
  vi.spyOn(trust, "appReleaseTrust").mockReturnValue({
    schema: "mdbn-app-trust/release/1", environment: "lab", cpOrigin: CP, logOrigin: "https://log.example.test",
    assetSha256: "aa".repeat(32), source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "test" },
    trustedRoots: [new Uint8Array(32).fill(1)], policyPins: Uint8Array.of(1),
  });
  const manifest = {
    manifest_version: 1 as const, id: "dev.example.identity-race", name: "Example", homepage: ORIGIN, redirect_uris: [`${ORIGIN}/callback`],
    requirements: { access: "full_collection" as const, contracts: [], capabilities: { contract_version: 2 as const, required: ["collection.read"], optional: [] } },
  };
  const declaration: MdbaseApplicationDeclaration = { id: APP, name: "Example", origin: ORIGIN, environment: "lab", manifest };
  const canonical = parseVersionedAppManifest(manifest, { allowLocal: true }).manifest;
  const store = memoryAppGrantStore();
  const responderKey = generateKeyPair();
  const consentKeys: Uint8Array[] = [];
  const handoffs: { generation: number; coherent: boolean }[] = [];
  const refreshGenerations: number[] = [];
  let generation = -1;
  let offlineCp = false, fetchCount = 0, listingStatus = 200;
  let callback = "";
  let listener: ((url: string) => void) | null = null;
  let pauseRoute = false, pauseCarrier = false, pauseHandshake = false;
  let refreshMode: "normal" | "success" | "invalid" = "normal";
  let closedCarriers = 0;
  const routeEntered = deferred(), routeRelease = deferred();
  const carrierEntered = deferred(), carrierRelease = deferred();
  const handshakeEntered = deferred(), handshakeRelease = deferred();
  const refreshEntered = deferred(), refreshRelease = deferred();
  const tokens = (g: number) => ({ access_token: `access-${g}`, refresh_token: `refresh-${g}`, collection_id: COLLECTION, expires_in: o.expiresIn ?? 3600, refresh_expires_in: 3600 });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    fetchCount++;
    if (offlineCp) throw new TypeError("fixture CP offline");
    const path = String(input).slice(CP.length);
    const body = init?.body as URLSearchParams;
    if (path === "/v1/apps/register") return Response.json({ application: { id: APP, name: "Example", manifest_digest: "cc".repeat(32), canonical_identity: `bundle:${manifest.id}:sha256:${"cc".repeat(32)}`, family_identity: `bundle:${manifest.id}`, distribution: "web", application_declaration: canonical } });
    if (path === "/oauth/authorization_request") {
      const proof = JSON.parse(body.get("application_authorization")!) as { binding: { authorization_id: string; state: string } };
      const key = JSON.parse(body.get("client_noise_key")!) as { public_key: string };
      consentKeys.push(fromB64u(key.public_key));
      callback = `${ORIGIN}/callback?state=${proof.binding.state}&code=code-${consentKeys.length - 1}`;
      return Response.json({ authorization_id: proof.binding.authorization_id, authorization_uri: `${CP}/oauth/authorize?id=fixture` });
    }
    if (path === "/oauth/token") {
      if (body.get("grant_type") === "authorization_code") {
        generation = Number(body.get("code")!.split("-")[1]);
        return Response.json(tokens(generation));
      }
      const requested = Number(body.get("refresh_token")!.split("-")[1]);
      refreshGenerations.push(requested);
      const mode = refreshMode;
      if (mode !== "normal") {
        refreshMode = "normal";
        refreshEntered.resolve();
        await refreshRelease.promise;
        // Success models a committed response delayed in delivery; invalid models
        // refusal arriving after a new consent's independent local commit.
        if (mode === "success") return Response.json(tokens(requested));
      }
      return mode !== "invalid" && requested === generation ? Response.json(tokens(requested)) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (path === `/v1/next/collections/${COLLECTION}/route`) {
      // Resolve the principal from THIS request's bearer, never from a shared CID.
      const requested = Number(new Headers(init?.headers).get("authorization")!.split("-")[1]);
      if (pauseRoute) {
        pauseRoute = false;
        routeEntered.resolve();
        await routeRelease.promise;
      }
      // Reapproval superseded the old credential while its route was in flight.
      if (o.revokePrior !== false && requested !== generation) return new Response(null, { status: 401 });
      return Response.json({ collection: COLLECTION, grant: GRANTS[requested], availability: { state: "available" }, targets: [{ device: DEVICE, relay_collection: COLLECTION, noise_pk: toHex(responderKey.publicKey), online: true, url: "wss://relay.example.test/v1/next/relay/client" }] });
    }
    if (path === "/v1/next/apps/collections") return listingStatus === 200
      ? Response.json({ collections: [{ collection: COLLECTION, name: "Example", state: "synced_e2e", operations: ["read"], availability: { state: "available" } }] })
      : new Response(null, { status: listingStatus });
    throw new Error(`unexpected fixture request ${path}`);
  };
  const webSocket = (): WebSocketLike => {
    let pipeGeneration = -1;
    let closed = false;
    const emit = (data: string | ArrayBuffer) => queueMicrotask(() => { if (!closed) ws.onmessage?.({ data }); });
    const ws: WebSocketLike = {
      binaryType: "blob", readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      close: () => { if (closed) return; closed = true; closedCarriers++; queueMicrotask(() => ws.onclose?.({ code: 1000 })); },
      send: (data) => {
        if (typeof data === "string") {
          const auth = JSON.parse(data) as { access_token: string; grant: string; collection: string; device: string };
          pipeGeneration = Number(auth.access_token.split("-")[1]);
          expect(auth).toMatchObject({ grant: GRANTS[pipeGeneration], collection: COLLECTION, device: DEVICE });
          if (pauseCarrier) {
            pauseCarrier = false;
            carrierEntered.resolve();
            void carrierRelease.promise.then(() => emit(JSON.stringify({ type: "pipe_opened" })));
          } else emit(JSON.stringify({ type: "pipe_opened" }));
          return;
        }
        const hs = new IkResponder({ staticKey: responderKey, prologue: clientPrologue(uuidToBytes(COLLECTION), uuidToBytes(GRANTS[pipeGeneration]!), uuidToBytes(DEVICE)) });
        const first = hs.readMessage1((data as Uint8Array).slice(4));
        const coherent = toHex(first.remoteStatic) === toHex(consentKeys[pipeGeneration]!);
        handoffs.push({ generation: pipeGeneration, coherent });
        // Model native admission: crossed identity is refused, not made READY.
        if (!coherent) {
          emit(JSON.stringify({ type: "pipe_close", reason: "unauthenticated" }));
          return;
        }
        const reply = hs.writeMessage2(encode(new Map())).message;
        const frame = new Uint8Array(4 + reply.length);
        new DataView(frame.buffer).setUint32(0, reply.length);
        frame.set(reply, 4);
        if (pauseHandshake) {
          pauseHandshake = false;
          handshakeEntered.resolve();
          void handshakeRelease.promise.then(() => emit(frame.buffer));
        } else emit(frame.buffer);
      },
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
  const makeGrants = () => new MdbaseAppGrants({ declaration, redirectUri: `${ORIGIN}/callback`, store, fetch, webSocket, callbacks: { subscribe: (l) => { listener = l; return () => { listener = null; }; } } });
  const grants = makeGrants();
  const authorize = (owner = grants) => owner.authorize({ popup: { closed: false, close: () => {}, navigate: () => { setTimeout(() => listener?.(callback), 0); } } });
  return {
    grants, store, authorize, makeGrants, authorizeFromAnotherInstance: () => authorize(makeGrants()), handoffs, refreshGenerations, consentKeys,
    setOfflineCp: () => { offlineCp = true; }, get fetchCount() { return fetchCount; }, setListingStatus: (status: number) => { listingStatus = status; },
    routeEntered, routeRelease, carrierEntered, carrierRelease, handshakeEntered, handshakeRelease, refreshEntered, refreshRelease,
    pauseNextRoute: () => { pauseRoute = true; }, pauseNextCarrier: () => { pauseCarrier = true; }, pauseNextHandshake: () => { pauseHandshake = true; },
    pauseNextRefresh: (mode: "success" | "invalid") => { refreshMode = mode; }, get closedCarriers() { return closedCarriers; },
  };
}

it("sequential reauthorization uses an explicit fresh connector, never a pending predecessor's keys", async () => {
  const f = fixture();
  const connector = f.grants.connector(COLLECTION);
  for (let generation = 0; generation < 2; generation++) {
    await f.authorize();
    const stored = (await f.store.getGrant(COLLECTION))!;
    expect(toHex(stored.noisePublicKey)).toBe(toHex(f.consentKeys[generation]!));
    if (generation > 0) await expect(connector.open(new Map(), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: "cancelled", message: "the stored grant changed during this operation" });
    const opened = await (generation === 0 ? connector : f.grants.connector(COLLECTION)).open(new Map(), AbortSignal.timeout(2_000));
    opened.port.close();
  }
  expect(f.handoffs).toEqual([{ generation: 0, coherent: true }, { generation: 1, coherent: true }]);
  expect(f.refreshGenerations).toEqual([]);
});

it("fences an old open or keeps its identity coherent when reauthorization crosses awaited route", async () => {
  const f = fixture();
  await f.authorize();
  const original = (await f.store.getGrant(COLLECTION))!;
  f.pauseNextRoute();
  // Attach rejection handling immediately: a fenced/refused old turn is allowed.
  const outcome = f.grants.connector(COLLECTION).open(new Map(), AbortSignal.timeout(2_000)).then((opened) => { opened.port.close(); return "opened"; }, () => "refused");
  await f.routeEntered.promise;
  await f.authorize();
  const replacement = (await f.store.getGrant(COLLECTION))!;
  expect(toHex(replacement.noisePublicKey)).not.toBe(toHex(original.noisePublicKey));
  expect(replacement.signingPrivateKey).not.toBe(original.signingPrivateKey);
  f.routeRelease.resolve();
  const result = await outcome;
  // An earlier SDK fence may avoid refresh entirely; any refresh must use the
  // replacement's credential, never resurrect the superseded original grant.
  expect(f.refreshGenerations.every((generation) => generation === 1)).toBe(true);
  if (!f.handoffs.length) expect(result).toBe("refused");
  // Refusal alone is NOT the SDK fence: never hand new grant + old key to native.
  expect(f.handoffs.every((handoff) => handoff.coherent)).toBe(true);
});

it("concurrent opens on one original connector retain the same consent and coherent static key", async () => {
  const f = fixture();
  await f.authorize();
  const connector = f.grants.connector(COLLECTION);
  f.pauseNextRoute();
  const first = connector.open(new Map(), AbortSignal.timeout(2_000));
  await f.routeEntered.promise;
  const second = await connector.open(new Map(), AbortSignal.timeout(2_000));
  second.port.close();
  f.routeRelease.resolve();
  (await first).port.close();
  expect(f.handoffs).toEqual([{ generation: 0, coherent: true }, { generation: 0, coherent: true }]);
  expect(f.consentKeys).toHaveLength(1);
});

it("concurrent predecessor and successor opens keep their original keys and require distinct connectors", async () => {
  // This model keeps prior credentials live. Reauthorization does NOT universally
  // revoke them; the regression must not rely on that CP policy assumption.
  const f = fixture({ revokePrior: false });
  await f.authorize();
  const connector = f.grants.connector(COLLECTION);
  f.pauseNextRoute();
  const old = connector.open(new Map(), AbortSignal.timeout(2_000)).then((opened) => { opened.port.close(); }, () => {});
  await f.routeEntered.promise;
  await f.authorize();
  await expect(connector.open(new Map(), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: "cancelled", message: "the stored grant changed during this operation" });
  const replacement = await f.grants.connector(COLLECTION).open(new Map(), AbortSignal.timeout(2_000));
  replacement.port.close();
  f.routeRelease.resolve();
  await old;
  expect(f.handoffs.some((handoff) => handoff.generation === 1 && handoff.coherent)).toBe(true);
  expect(f.handoffs.every((handoff) => handoff.coherent)).toBe(true);
});

it("fences replacement during carrier await before sending IK", async () => {
  const f = fixture();
  await f.authorize();
  const connector = f.grants.connector(COLLECTION);
  f.pauseNextCarrier();
  const old = connector.open(new Map(), AbortSignal.timeout(2_000)).then((opened) => { opened.port.close(); return "opened"; }, () => "refused");
  await f.carrierEntered.promise;
  await f.authorize();
  f.carrierRelease.resolve();
  expect(await old).toBe("refused");
  expect(f.handoffs).toEqual([]);
  expect(f.closedCarriers).toBe(1);
  expect(connector.target).toBeNull();
});

it("closes a stale completed handshake without publishing its sticky target", async () => {
  const f = fixture();
  await f.authorize();
  const connector = f.grants.connector(COLLECTION);
  f.pauseNextHandshake();
  const old = connector.open(new Map(), AbortSignal.timeout(2_000)).then((opened) => { opened.port.close(); return "opened"; }, () => "refused");
  await f.handshakeEntered.promise;
  await f.authorize();
  f.handshakeRelease.resolve();
  expect(await old).toBe("refused");
  expect(f.handoffs).toEqual([{ generation: 0, coherent: true }]);
  expect(f.closedCarriers).toBe(1);
  expect(connector.target).toBeNull();
});

it("a pinned original connector still opens after same-consent credential renewal", async () => {
  const f = fixture({ expiresIn: 30 });
  await f.authorize();
  const initial = (await f.store.getGrant(COLLECTION))!;
  const connector = f.grants.connector(COLLECTION);
  for (let attempt = 0; attempt < 2; attempt++) (await connector.open(new Map(), AbortSignal.timeout(2_000))).port.close();
  const current = (await f.store.getGrant(COLLECTION))!;
  expect(current.noisePrivateKey).toBe(initial.noisePrivateKey);
  expect(current.signingPrivateKey).toBe(initial.signingPrivateKey);
  expect(f.refreshGenerations.length).toBeGreaterThan(0);
  expect(f.refreshGenerations.every(g => g === 0)).toBe(true);
  expect(f.consentKeys).toHaveLength(1);
  expect(f.handoffs).toEqual([{ generation: 0, coherent: true }, { generation: 0, coherent: true }]);
});

it("normal refresh preserves the original Noise and signing identity", async () => {
  const f = fixture({ expiresIn: 30 });
  await f.authorize();
  const original = (await f.store.getGrant(COLLECTION))!;
  await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "available" });
  const refreshed = (await f.store.getGrant(COLLECTION))!;
  expect(toHex(refreshed.noisePublicKey)).toBe(toHex(original.noisePublicKey));
  expect(refreshed.noisePrivateKey).toBe(original.noisePrivateKey);
  expect(refreshed.signingPrivateKey).toBe(original.signingPrivateKey);
  expect(f.refreshGenerations).toEqual([0]);
});

for (const mode of ["success", "invalid"] as const) {
  it(`stale refresh ${mode} cannot overwrite/delete or publish over reauthorization`, async () => {
    const f = fixture({ expiresIn: 30 });
    await f.authorize();
    f.pauseNextRefresh(mode);
    const old = f.grants.availability(COLLECTION).then(() => "completed", () => "refused");
    await f.refreshEntered.promise;
    await f.authorize();
    const replacement = (await f.store.getGrant(COLLECTION))!;
    f.refreshRelease.resolve();
    await old;
    const current = await f.store.getGrant(COLLECTION);
    expect(current !== undefined && toHex(current.noisePublicKey) === toHex(replacement.noisePublicKey)).toBe(true);
    expect(current!.signingPrivateKey).toBe(replacement.signingPrivateKey);
    // A stale failure cannot poison the new authority or replace its bearer.
    await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "available" });
    expect(f.refreshGenerations.filter((generation) => generation === 0)).toHaveLength(1);
  });
}

for (const mode of ["success", "invalid"] as const) {
  it(`shared in-process commit lock preserves a peer instance after old refresh ${mode}`, async () => {
    vi.stubGlobal("navigator", {});
    const f = fixture({ expiresIn: 30 });
    await f.authorize();
    f.pauseNextRefresh(mode);
    const old = f.grants.availability(COLLECTION).catch(() => null);
    await f.refreshEntered.promise;
    await f.authorizeFromAnotherInstance();
    f.refreshRelease.resolve();
    await old;
    expect(toHex((await f.store.getGrant(COLLECTION))!.noisePublicKey)).toBe(toHex(f.consentKeys[1]!));
    // This instance still held the old cache; it must refresh the peer's original
    // replacement credential, not reuse or resurrect its own old authority.
    await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "available" });
    expect(f.refreshGenerations).toEqual([0, 1]);
  });
}

it("a fresh provided-store peer can forget keys with zero offline CP requests", async () => {
  const f = fixture();
  await f.authorize();
  const peer = f.makeGrants();
  const before = f.fetchCount;
  f.setOfflineCp();
  await peer.forget(COLLECTION);
  expect(await f.store.getGrant(COLLECTION)).toBeUndefined();
  expect(f.fetchCount).toBe(before);
});

it("cancelled refresh inventory cannot publish an empty COMPLETE listing", async () => {
  const f = fixture({ expiresIn: 30 });
  await f.authorize();
  f.pauseNextRefresh("success");
  const outcome = f.grants.collections().then((collections) => ({ collections }), (error: unknown) => ({ error }));
  await f.refreshEntered.promise;
  await f.authorizeFromAnotherInstance();
  f.refreshRelease.resolve();
  expect(await outcome).toMatchObject({ error: { code: "cancelled" } });
  expect(toHex((await f.store.getGrant(COLLECTION))!.noisePublicKey)).toBe(toHex(f.consentKeys[1]!));
});

it("a bare listing HTTP401 is failed inventory, not grant removal or empty COMPLETE", async () => {
  const f = fixture();
  await f.authorize();
  const original = (await f.store.getGrant(COLLECTION))!;
  f.setListingStatus(401);
  await expect(f.grants.collections()).rejects.toMatchObject({ code: "unauthenticated" });
  expect((await f.store.getGrant(COLLECTION))!.noisePrivateKey).toBe(original.noisePrivateKey);
  f.setListingStatus(200);
  await expect(f.grants.collections()).resolves.toHaveLength(1);
});

it("Web Locks protect all writer/cache commits in the same original namespace", async () => {
  const tails = new Map<string, Promise<void>>();
  const names: string[] = [];
  vi.stubGlobal("navigator", { locks: { request: async (name: string, options: { mode: string }, work: () => Promise<unknown>) => {
    expect(options.mode).toBe("exclusive");
    names.push(name);
    const previous = tails.get(name) ?? Promise.resolve();
    const pending = deferred();
    tails.set(name, pending.promise);
    await previous;
    try { return await work(); }
    finally { pending.resolve(); if (tails.get(name) === pending.promise) tails.delete(name); }
  } } });
  const f = fixture({ expiresIn: 30 });
  await f.authorize();
  f.pauseNextRefresh("invalid");
  const old = f.grants.availability(COLLECTION).catch(() => null);
  await f.refreshEntered.promise;
  await f.authorizeFromAnotherInstance();
  f.refreshRelease.resolve();
  await old;
  await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "available" });
  await f.grants.forget(COLLECTION);
  expect(await f.store.getGrant(COLLECTION)).toBeUndefined();
  const commits = names.filter((name) => name.startsWith("mdbase.app-grant.commit:"));
  expect(commits.length).toBeGreaterThanOrEqual(5);
  expect(new Set(commits).size).toBe(1);
  expect(names.some((name) => name.startsWith("mdbase.app-grant.refresh:") && !commits.includes(name))).toBe(true);
});

for (const mode of ["success", "invalid"] as const) {
  it(`old refresh ${mode} preserves a newer credential revision with unchanged keys`, async () => {
    const f = fixture({ expiresIn: 30 });
    await f.authorize();
    const original = (await f.store.getGrant(COLLECTION))!;
    f.pauseNextRefresh(mode);
    const old = f.grants.availability(COLLECTION).catch(() => null);
    await f.refreshEntered.promise;
    // Model an already-committed protected credential revision, not new consent.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`mdbase.app-grant.v2\0${CP}\0bundle:dev.example.identity-race\0${COLLECTION}`);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, original.refreshKey, new TextEncoder().encode("refresh-0")));
    const refresh = new Uint8Array(iv.length + cipher.length);
    refresh.set(iv); refresh.set(cipher, iv.length);
    await f.store.putGrant({ ...original, refresh });
    f.refreshRelease.resolve();
    await old;
    const current = (await f.store.getGrant(COLLECTION))!;
    expect(toHex(current.refresh)).toBe(toHex(refresh));
    expect(current.noisePrivateKey).toBe(original.noisePrivateKey);
    expect(current.signingPrivateKey).toBe(original.signingPrivateKey);
    await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "available" });
  });
}

it("setup's first use preserves the ORIGINAL connector grant instead of reading replacement custody",async()=>{
  const f=fixture();await f.authorize();
  const opened=await f.grants.connector(COLLECTION).open(new Map(),AbortSignal.timeout(2000));
  const session={} as Session;inheritOriginalAppGrant(opened.port,session);
  const client={collection:COLLECTION,currentSession:()=>session,readyForRead:async()=>session} as unknown as MdbaseClient;
  const setup=f.grants.setup(client); // deliberately NO first assessment before replacement
  await f.authorizeFromAnotherInstance();
  await expect(setup.assess()).rejects.toMatchObject({code:"cancelled",message:"the stored grant changed during this operation"});
  opened.port.close();
});
