// MdbaseAppGrants against a scripted control plane: the grant flow's wire shape, what
// is stored, single-use refresh, and bounded waits. No DOM, no network.
import { IDBFactory } from "fake-indexeddb";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import { MdbaseAppGrants, indexedDbAppGrantStore, memoryAppGrantStore, mergeCollectionEntries, type AppGrantStore, type StoredAppGrant } from "../src/app-grant/index.js";
import { applicationDeclaration, rebindApplicationDeclaration, type MdbaseApplicationDeclaration } from "../src/application/declaration.js";
import { resolveApplicationRegistration } from "../src/application/registration.js";
import * as trust from "../src/application/packaged-trust.js";
import { describeError } from "../src/describe-error.js";
import { ApplicationPrivateCollections } from "../src/application/private-collections.js";

const APP = "5cdfa020-c201-4da8-845a-f2cc9969eade";
const COLLECTION = "0b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e10";
const CP = "https://cp.example.test";
const ORIGIN = "http://127.0.0.1:48218";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const fromB64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function fixture(o: { manifestId?: string; namespace?: string; registeredId?: string; store?: AppGrantStore | "default"; nativeAccount?: string; nativeRequest?: string } = {}) {
  const manifestId = o.manifestId ?? "dev.example.web";
  const registeredId = o.registeredId ?? APP;
  vi.spyOn(trust, "appReleaseTrust").mockReturnValue({
    schema: "mdbn-app-trust/release/1", environment: "lab", cpOrigin: CP, logOrigin: "https://log.example.test",
    assetSha256: "aa".repeat(32), source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "test" },
    trustedRoots: [new Uint8Array(32).fill(1)], policyPins: Uint8Array.of(1),
  });
  const manifest = {
    manifest_version: 1 as const, id: manifestId, name: "Example", homepage: ORIGIN, redirect_uris: [`${ORIGIN}/callback`],
    requirements: { access: "full_collection" as const, contracts: [], capabilities: { contract_version: 2 as const, required: ["collection.read"], optional: [] } },
  };
  const declaration: MdbaseApplicationDeclaration = { id: APP, name: "Example", origin: ORIGIN, environment: "lab", manifest, ...(o.namespace?{storage:{applicationNamespace:o.namespace}}:{}) };
  const canonical = parseVersionedAppManifest(manifest, { allowLocal: true }).manifest;
  const digest = registeredId === APP ? "cc".repeat(32) : createHash("sha256").update(canonicalJson(canonical)).digest("hex");

  let listener: ((url: string) => void) | null = null;
  let callback = "";
  let preparedBinding: Record<string, string> | null = null;
  let preparedNoise = "";
  const requests: { path: string; body: URLSearchParams | null; headers: Headers }[] = [];
  let refreshCount = 0;
  let refreshReply: () => Response = () => Response.json({ access_token: `a${++refreshCount}`, refresh_token: `r${refreshCount}`, collection_id: COLLECTION, expires_in: 30, refresh_expires_in: 3600 });
  let availability: unknown = { state: "unavailable", reason: "device_offline" };
  let people: (resource: string, auth: string | null) => Response = () => Response.json({ error: { code: "approval_required" } }, { status: 403 });
  let listed: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = String(input).slice(CP.length);
    const body = typeof init?.body === "string" ? null : (init?.body as URLSearchParams | undefined) ?? null;
    requests.push({ path, body, headers: new Headers(init?.headers) });
    if (path === "/v1/apps/register") {
      return Response.json({ application: { id: registeredId, name: "Example", manifest_digest: digest, canonical_identity: `bundle:${manifestId}:sha256:${digest}`, family_identity: `bundle:${manifestId}`, distribution: "web", application_declaration: canonical } });
    }
    if (path === "/oauth/authorization_request") {
      const proof = JSON.parse(body!.get("application_authorization")!) as { binding: { authorization_id: string; state: string } };
      // The person approves after the popup opens.
      preparedBinding = proof.binding as unknown as Record<string, string>;
      preparedNoise = (JSON.parse(body!.get("client_noise_key")!) as { public_key: string }).public_key;
      callback = `${ORIGIN}/callback?state=${proof.binding.state}&code=the-code`;
      return Response.json({ authorization_id: proof.binding.authorization_id, authorization_uri: `${CP}/oauth/authorize?id=1` });
    }
    if (path === "/oauth/token" && body!.get("grant_type") === "authorization_code") {
      const grantId = "77777777-7777-4777-8777-777777777777";
      const native = o.nativeAccount ? { grant_id: grantId, application_origin: ORIGIN, native_completion: {
        version: 1, account_id: o.nativeAccount,
        authorization_request_id: o.nativeRequest ?? preparedBinding!.authorization_id,
        application_id: registeredId, application_declaration_id: manifestId, application_manifest_digest: digest,
        application_installation_id: preparedBinding!.application_installation_id, application_origin: ORIGIN,
        collection_id: COLLECTION, grant_id: grantId, grant_signing_public_key: preparedBinding!.grant_signing_public_key,
        client_noise_public_key: preparedNoise,
      } } : {};
      return Response.json({ access_token: "a0", refresh_token: "secret-refresh-0", collection_id: COLLECTION, expires_in: 30, refresh_expires_in: 3600, ...native });
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
  const popup = { navigate: vi.fn((_uri: string) => void setTimeout(() => listener?.(callback), 10)), close: vi.fn(), closed: false };
  return {
    grants, declaration, digest, store: store as AppGrantStore, popup, requests, fetch,
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

it("shares the exact current registration with Hosted bootstrap, never a superseded declared application UUID", async () => {
  const freshId = "88888888-8888-4888-8888-888888888888";
  const f = fixture({ registeredId: freshId });
  // Exact Entry.initialize path: register original declaration, rebind Worker appId.
  const original = applicationDeclaration(f.declaration);
  const registration = await resolveApplicationRegistration({ declaration: original, signal: new AbortController().signal, isCurrent: () => true, fetch: f.fetch });
  const hosted = rebindApplicationDeclaration(original, registration);
  expect(hosted.id).toBe(freshId);
  expect(hosted.id).not.toBe(f.declaration.id);
  const prepared = await f.grants.prepareAuthorization();
  try {
    const proof = JSON.parse(f.requests.find(r => r.path === "/oauth/authorization_request")!.body!.get("application_authorization")!);
    expect(proof.binding.application_id).toBe(hosted.id);
    expect(proof.binding.application_manifest_digest).toBe(registration.manifestDigest);
    expect(prepared).toMatchObject({ applicationId: hosted.id, manifestDigest: registration.manifestDigest });
    const bodies = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/apps/register")).map(([, init]) => init!.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  } finally { prepared.cancel(); }
});

it("prepares the original challenge-bound Private authorization without another popup or premature grant", async () => {
  const f = fixture();
  const nonce = btoa(String.fromCharCode(...new Uint8Array(32).fill(42))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const prepared = await f.grants.prepareAuthorization({
    authorizationNonce: nonce,
    expectedAccountId: "11111111-1111-4111-8111-111111111111",
  });
  const start = f.requests.find(r => r.path === "/oauth/authorization_request")!.body!;
  const proof = JSON.parse(start.get("application_authorization")!) as { binding: { authorization_id: string; authorization_nonce: string } };
  expect(proof.binding.authorization_nonce).toBe(nonce);
  expect(prepared.authorizationId).toBe(proof.binding.authorization_id);
  expect(prepared.authorizationUri).toBe(`${CP}/oauth/authorize?id=1`);
  expect(f.popup.navigate).not.toHaveBeenCalled();
  expect(f.popup.close).not.toHaveBeenCalled();
  expect(f.requests.some(r => r.path === "/oauth/token")).toBe(false);
  expect(await f.store.listGrants()).toEqual([]);
  prepared.cancel();
});

const ORIGINAL_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ORIGINAL_NONCE = btoa(String.fromCharCode(...new Uint8Array(32).fill(42))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

it("finishes the SAME early callback once and verifies the original Native owner before storing", async () => {
  const f = fixture({ nativeAccount: ORIGINAL_ACCOUNT });
  const prepared = await f.grants.prepareAuthorization({ authorizationNonce: ORIGINAL_NONCE, expectedAccountId: ORIGINAL_ACCOUNT });
  f.popup.navigate(prepared.authorizationUri);
  // Normal callback may precede the protected receipt/ACK and finish invocation.
  await new Promise(resolve => setTimeout(resolve, 25));
  const completed = await prepared.finish({ popup: f.popup, collection: COLLECTION });
  expect(completed.collectionId).toBe(COLLECTION);
  expect(completed.nativeCompletion?.account_id).toBe(ORIGINAL_ACCOUNT);
  expect(completed.nativeCompletion?.authorization_request_id).toBe(prepared.authorizationId);
  expect(await f.store.getGrant(COLLECTION)).toBeDefined();
  await expect(prepared.finish({ popup: f.popup, collection: COLLECTION })).rejects.toMatchObject({ reason: "authorization_binding" });
  expect(f.requests.filter(r => r.path === "/oauth/token")).toHaveLength(1);
  // The enclosing SDK flow owns popup closure after original ACK, not finish.
  expect(f.popup.close).not.toHaveBeenCalled();
});

it.each([
  { nativeAccount: "22222222-2222-4222-8222-222222222222" },
  { nativeAccount: ORIGINAL_ACCOUNT, nativeRequest: "33333333-3333-4333-8333-333333333333" },
  {},
])("refuses mismatched or missing Native completion before any credential persistence: %j", async options => {
  const f = fixture(options);
  const prepared = await f.grants.prepareAuthorization({ authorizationNonce: ORIGINAL_NONCE, expectedAccountId: ORIGINAL_ACCOUNT });
  f.popup.navigate(prepared.authorizationUri);
  await expect(prepared.finish({ popup: f.popup, collection: COLLECTION })).rejects.toMatchObject({ code: "unauthenticated" });
  expect(await f.store.listGrants()).toEqual([]);
});

it("cancels original preparation without exchanging a code or closing a shared popup", async () => {
  const f = fixture({ nativeAccount: ORIGINAL_ACCOUNT });
  const prepared = await f.grants.prepareAuthorization({ authorizationNonce: ORIGINAL_NONCE, expectedAccountId: ORIGINAL_ACCOUNT });
  prepared.cancel();
  await expect(prepared.finish({ popup: f.popup, collection: COLLECTION })).rejects.toMatchObject({ code: "cancelled" });
  expect(f.requests.some(r => r.path === "/oauth/token")).toBe(false);
  expect(await f.store.listGrants()).toEqual([]);
  expect(f.popup.close).not.toHaveBeenCalled();
});

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

it("a stale protected Noise binding cannot forget a newer or unrelated account's stored grant",async()=>{
  const f=await authorized(),original=await f.store.getGrant(COLLECTION);
  await expect(f.grants.forget(COLLECTION,{expectedNoisePublicKey:"stale-original-public-key"})).rejects.toMatchObject({code:"cancelled"});
  expect(await f.store.getGrant(COLLECTION)).toEqual(original);
  const key=btoa(String.fromCharCode(...original!.noisePublicKey)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
  await f.grants.forget(COLLECTION,{expectedNoisePublicKey:key});expect(await f.store.getGrant(COLLECTION)).toBeUndefined();
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

it("signs each refresh with the grant signing key registered at consent", async () => {
  const f = await authorized();
  const binding = (JSON.parse(f.requests.find((r) => r.path === "/oauth/authorization_request")!.body!.get("application_authorization")!) as { binding: { grant_signing_public_key: string } }).binding;
  expect((await f.store.getGrant(COLLECTION))!.signingPrivateKey!.extractable).toBe(false);
  await f.grants.availability(COLLECTION);
  const refresh = f.requests.find((r) => r.path === "/oauth/token" && r.body!.get("grant_type") === "refresh_token")!;
  const h = refresh.headers;
  expect(h.get("x-mdbase-proof-version")).toBe("1");
  const digest = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  // Connect rebuilds the body in this order and verifies over it.
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "secret-refresh-0", client_id: APP }).toString();
  expect(refresh.body!.toString()).toBe(body);
  const message = ["mdbase-authority-request-proof-v1", "1", "POST", "/oauth/token", await digest(body), await digest("secret-refresh-0"),
    h.get("x-mdbase-proof-timestamp"), h.get("x-mdbase-proof-nonce")].join("\n");
  const key = await crypto.subtle.importKey("raw", fromB64u(binding.grant_signing_public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64u(h.get("x-mdbase-proof-signature")!), new TextEncoder().encode(message))).toBe(true);
  // The rotated grant keeps its signing key for the next refresh.
  expect((await f.store.getGrant(COLLECTION))!.signingPrivateKey).toBeDefined();
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

const OTHER = "1b4c1a52-58f1-4a9e-9f43-6a7f8d2f3e11";
async function seededGrant(collection: string): Promise<StoredAppGrant> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const noise = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
  return { version: 1, collection, noisePrivateKey: noise.privateKey, noisePublicKey: new Uint8Array(32), refreshKey: key, refresh: new Uint8Array(28), refreshExpiresAt: Date.now() + 60_000 };
}

it("forgetAllGrants wipes every stored grant and setup attempt, listed or not, and keeps the app identity", async () => {
  const f = await authorized();
  // OTHER simulates a grant persisted just before a reload, never listed since.
  await f.store.putGrant(await seededGrant(OTHER));
  await f.store.putSetupAttemptIfAbsent!(COLLECTION, new Uint8Array([1, 2, 3]));
  await f.store.putSetupAttemptIfAbsent!(OTHER, new Uint8Array([4, 5]));
  const identity = await f.store.getIdentity();
  await f.grants.forgetAllGrants();
  expect(await f.store.listGrants()).toEqual([]);
  expect(await f.store.getSetupAttempt!(COLLECTION)).toBeUndefined();
  expect(await f.store.getSetupAttempt!(OTHER)).toBeUndefined();
  expect(await f.store.getIdentity()).toEqual(identity);
  // Idempotent (a follower tab wiping again), and people stay fenced.
  await f.grants.forgetAllGrants();
  expect(await f.store.listGrants()).toEqual([]);
});

it("IndexedDB clearGrants removes grants and setup attempts in one wipe and keeps the identity", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const store = indexedDbAppGrantStore(CP, APP, { owner: "bundle:dev.example.notes" });
  const p256 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) as CryptoKeyPair;
  const identity = await store.putIdentityIfAbsent({ version: 1, privateKey: p256.privateKey, publicKey: "pk" });
  await store.putGrant(await seededGrant(COLLECTION));
  await store.putGrant(await seededGrant(OTHER));
  await store.putSetupAttemptIfAbsent!(COLLECTION, new Uint8Array([9]));
  await store.clearGrants();
  expect(await store.listGrants()).toEqual([]);
  expect(await store.getSetupAttempt!(COLLECTION)).toBeUndefined();
  expect((await store.getIdentity())!.publicKey).toBe(identity.publicKey);
  await store.clearGrants(); // empty again: no error
});

it("a refresh in flight for an unlisted grant cannot resurrect it after the sign-out wipe", async () => {
  const f = await authorized();
  let release!: (r: Response) => void;
  const held = new Promise<Response>(r => { release = r; });
  f.setRefreshReply(() => held as unknown as Response);
  const racing = f.grants.availability(COLLECTION).then(() => "resolved", () => "rejected");
  await vi.waitFor(() => expect(f.requests.some(r => r.path === "/oauth/token" && r.body!.get("grant_type") === "refresh_token")).toBe(true));
  // Private collections never listed/refreshed in this page: the old sign-out
  // forgot only IDs it knew, so this grant (and its refresh) survived.
  const privates = new ApplicationPrivateCollections({ declaration: f.declaration, grants: async () => f.grants as never, onChange: () => {} });
  const wiping = privates.forgetAll();
  release(Response.json({ access_token: "a9", refresh_token: "r9", collection_id: COLLECTION, expires_in: 30, refresh_expires_in: 3600 }));
  await wiping;
  await racing;
  expect(await f.store.listGrants()).toEqual([]);
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
  const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
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
    const r = indexedDB.open(name);
    r.onsuccess = () => { const g = r.result.transaction("grants").objectStore("grants").get(COLLECTION); g.onsuccess = () => { resolve(g.result); r.result.close(); }; };
  });
  expect(raw).toMatchObject({ owner: "bundle:dev.example.reader" });
});

it("two vaults of one app keep separate grant identities, refresh tokens and setup attempts on sign-out",async()=>{
  vi.stubGlobal("indexedDB",new IDBFactory());
  const a=fixture({store:"default",namespace:"vault-a"}),b=fixture({store:"default",namespace:"vault-b"});
  await a.grants.authorize({popup:a.popup});
  expect(await b.grants.collections()).toEqual([]);
  await b.grants.authorize({popup:b.popup});
  const identityA=await Reflect.get(a.grants,"identity").call(a.grants),identityB=await Reflect.get(b.grants,"identity").call(b.grants);
  expect(identityA.owner).not.toBe(identityB.owner);expect(identityA.publicKey).not.toEqual(identityB.publicKey);
  const storeA=await Reflect.get(a.grants,"store").call(a.grants),storeB=await Reflect.get(b.grants,"store").call(b.grants);
  await storeA.putSetupAttemptIfAbsent(COLLECTION,new Uint8Array([1]));
  expect(await storeB.getSetupAttempt(COLLECTION)).toBeUndefined();
  await storeB.putSetupAttemptIfAbsent(COLLECTION,new Uint8Array([2]));
  await a.grants.forgetAllGrants();
  expect(await a.grants.collections()).toEqual([]);
  expect(await storeB.listGrants()).toHaveLength(1);
  expect(await storeB.getSetupAttempt(COLLECTION)).toEqual(new Uint8Array([2]));
  expect(await Reflect.get(b.grants,"identity").call(b.grants)).toEqual(identityB);
  // Reload the signed-in sibling: its protected refresh token still works.
  const restored=fixture({store:"default",namespace:"vault-b"});
  expect(await Reflect.get(restored.grants,"store").call(restored.grants).then((s:AppGrantStore)=>s.listGrants())).toHaveLength(1);
  expect(await restored.grants.availability(COLLECTION)).toEqual({state:"unavailable",reason:"device_offline"});
  expect(restored.requests.some(r=>r.path==="/oauth/token")).toBe(true);
});
