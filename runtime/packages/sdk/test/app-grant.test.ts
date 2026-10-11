// MdbaseAppGrants against a scripted control plane: the grant flow's wire shape, what
// is stored, single-use refresh, and bounded waits. No DOM, no network.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import { MdbaseAppGrants, indexedDbAppGrantStore, memoryAppGrantStore, mergeCollectionEntries, type AppGrantStore, type StoredAppGrant } from "../src/app-grant/index.js";
import type { MdbaseApplicationDeclaration } from "../src/application/declaration.js";
import * as trust from "../src/application/packaged-trust.js";
import { describeError } from "../src/describe-error.js";

const APP = "5cdfa020-c201-4da8-845a-f2cc9969eade";
const COLLECTION = "0b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e10";
const CP = "https://cp.example.test";
const ORIGIN = "http://127.0.0.1:48218";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const fromB64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

function fixture(o: { manifestId?: string; store?: AppGrantStore | "default" } = {}) {
  const manifestId = o.manifestId ?? "dev.example.web";
  vi.spyOn(trust, "appReleaseTrust").mockReturnValue({
    schema: "mdbn-app-trust/release/1", environment: "lab", cpOrigin: CP, logOrigin: "https://log.example.test",
    assetSha256: "aa".repeat(32), source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "test" },
    trustedRoots: [new Uint8Array(32).fill(1)], policyPins: Uint8Array.of(1),
  });
  const manifest = {
    manifest_version: 1 as const, id: manifestId, name: "Example", homepage: ORIGIN, redirect_uris: [`${ORIGIN}/callback`],
    requirements: { access: "full_collection" as const, contracts: [], capabilities: { contract_version: 2 as const, required: ["collection.read"], optional: [] } },
  };
  const declaration: MdbaseApplicationDeclaration = { id: APP, name: "Example", origin: ORIGIN, environment: "lab", manifest };
  const canonical = parseVersionedAppManifest(manifest, { allowLocal: true }).manifest;

  let listener: ((url: string) => void) | null = null;
  let callback = "";
  const requests: { path: string; body: URLSearchParams | null }[] = [];
  let refreshCount = 0;
  let refreshReply: () => Response = () => Response.json({ access_token: `a${++refreshCount}`, refresh_token: `r${refreshCount}`, collection_id: COLLECTION, expires_in: 30, refresh_expires_in: 3600 });
  let availability: unknown = { state: "unavailable", reason: "device_offline" };
  let people: (resource: string, auth: string | null) => Response = () => Response.json({ error: { code: "approval_required" } }, { status: 403 });
  let listed: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = String(input).slice(CP.length);
    const body = typeof init?.body === "string" ? null : (init?.body as URLSearchParams | undefined) ?? null;
    requests.push({ path, body });
    if (path === "/v1/apps/register") {
      return Response.json({ application: { id: APP, name: "Example", manifest_digest: "cc".repeat(32), canonical_identity: `bundle:${manifestId}:sha256:${"cc".repeat(32)}`, family_identity: `bundle:${manifestId}`, distribution: "web", application_declaration: canonical } });
    }
    if (path === "/oauth/authorization_request") {
      const proof = JSON.parse(body!.get("application_authorization")!) as { binding: { authorization_id: string; state: string } };
      // The person approves after the popup opens.
      callback = `${ORIGIN}/callback?state=${proof.binding.state}&code=the-code`;
      return Response.json({ authorization_id: proof.binding.authorization_id, authorization_uri: `${CP}/oauth/authorize?id=1` });
    }
    if (path === "/oauth/token" && body!.get("grant_type") === "authorization_code") {
      return Response.json({ access_token: "a0", refresh_token: "secret-refresh-0", collection_id: COLLECTION, expires_in: 30, refresh_expires_in: 3600 });
    }
    if (path === "/oauth/token") return refreshReply();
    const person = /^\/v1\/authorities\/([^/?]+)\/(identity|members)$/.exec(path);
    if (person) {
      expect(person[1]).toBe(COLLECTION);
      return people(person[2]!, new Headers(init?.headers).get("authorization"));
    }
    if (path === `/v1/next/collections/${COLLECTION}/route`) {
      return Response.json({ collection: COLLECTION, grant: "7f1c9a3e-2b4d-4c5e-8f6a-1b2c3d4e5f60", targets: [], availability });
    }
    if (path === "/v1/next/apps/collections") return Response.json({ collections: listed });
    return new Response(null, { status: 404 });
  });
  const store = o.store === "default" ? undefined : o.store ?? memoryAppGrantStore();
  const grants = new MdbaseAppGrants({
    declaration, redirectUri: `${ORIGIN}/callback`, ...(store ? { store } : {}), fetch,
    callbacks: { subscribe: (l) => { listener = l; return () => { listener = null; }; } },
  });
  const popup = { navigate: vi.fn(() => void setTimeout(() => listener?.(callback), 10)), close: vi.fn(), closed: false };
  return {
    grants, store: store as AppGrantStore, popup, requests, fetch,
    setAvailability: (a: unknown) => { availability = a; },
    setListed: (l: unknown[]) => { listed = l; },
    setRefreshReply: (r: () => Response) => { refreshReply = r; },
    setPeople: (r: typeof people) => { people = r; },
  };
}

async function authorized() {
  const f = fixture();
  await expect(f.grants.authorize({ popup: f.popup })).resolves.toEqual({ collectionId: COLLECTION });
  return f;
}

it("sends an attested client Noise key and stores no secret in readable form", async () => {
  const f = await authorized();
  const start = f.requests.find((r) => r.path === "/oauth/authorization_request")!.body!;
  expect(start.get("code_challenge_method")).toBe("S256");
  const proof = JSON.parse(start.get("application_authorization")!) as { binding: { authorization_id: string; grant_signing_public_key: string } };
  const noiseKey = JSON.parse(start.get("client_noise_key")!) as { public_key: string; signature: string };
  const pk = fromB64u(noiseKey.public_key);
  const id = Uint8Array.from(proof.binding.authorization_id.replaceAll("-", "").match(/../g)!.map((h) => parseInt(h, 16)));
  const message = new Uint8Array([...new TextEncoder().encode("mdbase-next client noise key v1\0"), 0, 0, 0, 16, ...id, 0, 0, 0, 32, ...pk]);
  const signer = await crypto.subtle.importKey("raw", fromB64u(proof.binding.grant_signing_public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signer, fromB64u(noiseKey.signature), message)).toBe(true);
  expect(f.popup.navigate).toHaveBeenCalledWith(`${CP}/oauth/authorize?id=1`);
  expect(f.popup.close).toHaveBeenCalled();

  const grant = (await f.store.getGrant(COLLECTION))!;
  expect(grant.noisePrivateKey.extractable).toBe(false);
  expect(grant.refreshKey.extractable).toBe(false);
  expect((await f.store.getIdentity())!.privateKey.extractable).toBe(false);
  expect(new TextDecoder().decode(grant.refresh)).not.toContain("secret-refresh-0");
  expect([...grant.noisePublicKey]).toEqual([...pk]);
});

it("refreshes once for concurrent callers and forgets a refused grant", async () => {
  const f = await authorized();
  // The access token expires within a minute, so both callers refresh, once.
  await Promise.all([f.grants.availability(COLLECTION), f.grants.availability(COLLECTION)]);
  const refreshes = f.requests.filter((r) => r.path === "/oauth/token" && r.body!.get("grant_type") === "refresh_token");
  expect(refreshes.map((r) => r.body!.get("refresh_token"))).toEqual(["secret-refresh-0"]);

  f.setRefreshReply(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(f.grants.availability(COLLECTION)).rejects.toMatchObject({ code: "unauthenticated", reason: "grant_invalid" });
  expect(await f.store.getGrant(COLLECTION)).toBeUndefined();
  // Without a grant the collection must be given access again.
  await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "unavailable", reason: "sync_required" });
});

it("waits for availability within its bound and never on access_removed", async () => {
  const f = await authorized();
  const seen: unknown[] = [];
  const started = Date.now();
  await expect(f.grants.waitForAvailable(COLLECTION, { timeoutMs: 1_200, intervalMs: 1_000, onAvailability: (a) => seen.push(a) }))
    .resolves.toEqual({ state: "unavailable", reason: "device_offline" });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(seen).toEqual([{ state: "unavailable", reason: "device_offline" }]);

  f.setAvailability({ state: "unavailable", reason: "access_removed" });
  const before = f.requests.length;
  await expect(f.grants.waitForAvailable(COLLECTION, { timeoutMs: 60_000 })).resolves.toEqual({ state: "unavailable", reason: "access_removed" });
  expect(f.requests.filter((r) => r.path.endsWith("/route")).length).toBe(f.requests.slice(0, before).filter((r) => r.path.endsWith("/route")).length + 1);

  // Opening refuses an unavailable collection with its reason and copy.
  const opened = f.grants.connector(COLLECTION).open(new Uint8Array(), new AbortController().signal);
  const error = await opened.then(() => null, (e: unknown) => e);
  expect(error).toMatchObject({ code: "forbidden", reason: "access_removed" });
  expect(describeError(error)?.title).toBe("You no longer have access");
});

it("keeps unknown availability closed", async () => {
  const f = await authorized();
  f.setAvailability({ state: "available-ish" });
  await expect(f.grants.availability(COLLECTION)).resolves.toEqual({ state: "unavailable", reason: "device_offline" });
  void (f.store satisfies AppGrantStore);
});

it("merges cloud copies and Private collections into one list with one availability shape", () => {
  const merged = mergeCollectionEntries(
    [
      { collectionId: "b0000000-0000-4000-8000-000000000001", displayName: "Notes", role: "owner" },
      { collectionId: "b0000000-0000-4000-8000-000000000002", displayName: "Archive", role: "viewer", availability: { state: "unavailable", reason: "access_removed" } },
    ],
    [{ collectionId: COLLECTION, displayName: "Journal", operations: [], role: null, availability: { state: "unavailable", reason: "device_offline" } }],
  );
  expect(merged.map((e) => [e.displayName, e.kind, e.availability])).toEqual([
    ["Archive", "cloud_copy", { state: "unavailable", reason: "access_removed" }],
    ["Journal", "private", { state: "unavailable", reason: "device_offline" }],
    ["Notes", "cloud_copy", { state: "available" }],
  ]);
});

it("keeps each entry's role: the cloud copy's, and the Private collection's when Connect reports it", async () => {
  const f = await authorized();
  const other = "b0000000-0000-4000-8000-000000000003";
  f.setListed([
    { collection: COLLECTION, name: "Journal", state: "synced_e2e", operations: ["read"], role: "owner", availability: { state: "available" } },
    { collection: other, name: "Shared", state: "synced_e2e", operations: ["read"], role: "admin", availability: { state: "available" } },
  ]);
  const privates = await f.grants.collections();
  expect(privates.map((p) => [p.displayName, p.role])).toEqual([["Journal", "owner"], ["Shared", null]]);
  const merged = mergeCollectionEntries([{ collectionId: "b0000000-0000-4000-8000-000000000001", displayName: "Notes", role: "editor" }], privates);
  expect(merged.map((e) => [e.displayName, e.kind, e.role])).toEqual([["Journal", "private", "owner"], ["Notes", "cloud_copy", "editor"], ["Shared", "private", null]]);
});

it("reads people metadata for a Private collection with the grant's token, after device approval", async () => {
  const f = await authorized();
  const people = f.grants.people(COLLECTION, {} as never);
  const refused = await people.current().then(() => null, (e: unknown) => e);
  expect(refused).toMatchObject({ code: "unavailable", reason: "approval_required" });
  expect(describeError(refused)?.key).toBe("device_approval_required");

  const owner = { issuer: "https://cp.example.test", subject: "acct_1", name: "Ada", account_id: "c0000000-0000-4000-8000-000000000001" };
  f.setPeople((resource, auth) => {
    expect(auth).toMatch(/^Bearer a\d+$/);
    return resource === "identity" ? Response.json(owner) : Response.json({ error: { code: "insufficient_access" } }, { status: 403 });
  });
  await expect(people.current()).resolves.toEqual({ issuer: owner.issuer, subject: owner.subject, name: "Ada", accountId: owner.account_id });
  await expect(people.members()).rejects.toMatchObject({ code: "forbidden", reason: "people_permission_declined" });

  f.setPeople(() => Response.json({ members: [{ ...owner, role: "owner" }] }));
  await expect(people.members()).resolves.toEqual([{ issuer: owner.issuer, subject: owner.subject, name: "Ada", accountId: owner.account_id, role: "owner" }]);
  await f.grants.forget(COLLECTION);
  await expect(people.current()).rejects.toMatchObject({ code: "unauthenticated", reason: "people_fenced" });
});

// Local owner: the CP assigns the application id, so the default grant store is
// labelled with the app's own manifest family and a wrong id never selects,
// uses or deletes another app's identity or grants.
it("a registration id that points at another app's grant store never opens it; the owner's own reopen does", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const notes = fixture({ manifestId: "dev.example.notes", store: "default" });
  await expect(notes.grants.authorize({ popup: notes.popup })).resolves.toEqual({ collectionId: COLLECTION });
  const notesStore = indexedDbAppGrantStore(CP, APP, { owner: "bundle:dev.example.notes" });
  const paired = (await notesStore.getGrant(COLLECTION))!;
  expect(paired.owner).toBe("bundle:dev.example.notes");
  const identity = (await notesStore.getIdentity())!;

  // Another family given the same id by a wrong registration reply: an empty store,
  // a fresh signing identity, and forget leaves the paired grant alone.
  const reader = fixture({ manifestId: "dev.example.reader", store: "default" });
  await reader.grants.forget(COLLECTION);
  const readerStore = indexedDbAppGrantStore(CP, APP, { owner: "bundle:dev.example.reader" });
  expect(await readerStore.getGrant(COLLECTION)).toBeUndefined();
  expect(await readerStore.getIdentity()).toBeUndefined();
  expect(await notesStore.getGrant(COLLECTION)).toMatchObject({ collection: COLLECTION, noisePublicKey: paired.noisePublicKey });

  // The owner's own reopen restores the grant and refreshes with it.
  const again = fixture({ manifestId: "dev.example.notes", store: "default" });
  expect((await indexedDbAppGrantStore(CP, APP, { owner: "bundle:dev.example.notes" }).getIdentity())!.publicKey).toBe(identity.publicKey);
  await expect((again.grants as unknown as { accessToken(c: string): Promise<string> }).accessToken(COLLECTION)).resolves.toBe("a1");
});

it("refuses records labelled for another owner and never adopts an unlabelled store", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const noise = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
  const grant: StoredAppGrant = { version: 1, collection: COLLECTION, noisePrivateKey: noise.privateKey, noisePublicKey: new Uint8Array(32), refreshKey: key, refresh: new Uint8Array(28), refreshExpiresAt: Date.now() + 60_000 };

  const legacy = indexedDbAppGrantStore(CP, APP);
  await legacy.putGrant(grant);
  const labelled = indexedDbAppGrantStore(CP, APP, { owner: "bundle:dev.example.notes" });
  expect(await labelled.getGrant(COLLECTION)).toBeUndefined();
  expect(await labelled.listGrants()).toEqual([]);
  expect(await legacy.getGrant(COLLECTION)).toBeDefined();

  // A record carrying another owner, however it got into this store, is refused
  // for read, overwrite and delete, and stays in place.
  await labelled.putGrant(grant);
  const name = `mdbase.app-grants.v2.${encodeURIComponent(CP)}.${encodeURIComponent("bundle:dev.example.notes")}.${APP}`;
  const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(name, 1); r.onsuccess = () => resolve(r.result); });
  await new Promise<void>((resolve) => {
    const tx = db.transaction("grants", "readwrite");
    tx.objectStore("grants").put({ ...grant, owner: "bundle:dev.example.reader" }, COLLECTION);
    tx.oncomplete = () => resolve();
  });
  db.close();
  for (const attempt of [() => labelled.getGrant(COLLECTION), () => labelled.listGrants(), () => labelled.putGrant(grant), () => labelled.deleteGrant(COLLECTION)]) {
    await expect(attempt()).rejects.toMatchObject({ code: "unauthenticated" });
  }
  const raw = await new Promise<unknown>((resolve) => {
    const r = indexedDB.open(name, 1);
    r.onsuccess = () => { const g = r.result.transaction("grants").objectStore("grants").get(COLLECTION); g.onsuccess = () => { resolve(g.result); r.result.close(); }; };
  });
  expect(raw).toMatchObject({ owner: "bundle:dev.example.reader" });
});
