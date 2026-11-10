import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppWebSignInSession, type AppWebSignInPortal } from "../src/app-host/web-sign-in-session.js";
import { AppInstallationStore } from "../src/app-host/installation-store.js";
import { AppWebCloudCopyHost } from "../src/app-host/cloud-copy-host.js";
import type { AppBundledReleaseTrust } from "../src/app-host/cloud-copy-bootstrap.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
import * as ownership from "../src/app-host/owner.js";

// The REAL session over the REAL protected sign-in flow, from START. Only the
// edges are stand-ins: the Connect server is a fetch that answers with the
// shapes the server sends (taken from the local Private device end-to-end run),
// the protected store is in memory, and the device host signs with fixed keys.
// The portal's decisions are the `cp` switches below.
const origin = "https://notes.example.test", cpOrigin = "https://cp.example.test", appName = "Independent Notes", appId = "44444444-4444-4444-8444-444444444444";
const account = "11111111-1111-4111-8111-111111111111", connector = "22222222-2222-4222-8222-222222222222";
const cloud = "33333333-3333-4333-8333-333333333333", priv = "66666666-6666-4666-8666-666666666666";
const release: AppBundledReleaseTrust = {schema: "mdbn-app-trust/release/1", environment: "production", cpOrigin, logOrigin: "https://log.example.test", assetSha256: "11".repeat(32), source: {repository: "mdbase-dev/mdbase-connect", commit: "22".repeat(20), version: "test"}, trustedRoots: [new Uint8Array(32).fill(3)], policyPins: Uint8Array.of(1)};
const pk = {signPublicKey: new Uint8Array(32).fill(3), kemPublicKey: new Uint8Array(32).fill(4), noisePublicKey: new Uint8Array(32).fill(5)};
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
const rows = {
  cloud: {collection_id: cloud, display_name: "My notes", role: "owner"},
  priv: {collection_id: priv, display_name: "Private notes", role: "owner"},
};
type Receipt = Record<string, unknown>;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(options: {autoSelect?: "only" | "never"; declaresPrivateDevice?: boolean} = {}) {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("location", {origin});
  let saved: Uint8Array | null = null, current = true;
  const read = () => JSON.parse(new TextDecoder().decode(saved!));
  const store = {isCurrent: () => current, commit: async (value: Uint8Array) => { saved?.fill(0); saved = new Uint8Array(value); }, close: async () => { current = false; }};
  vi.spyOn(AppInstallationStore, "open").mockImplementation(async (_p, initial) => {
    current = true; saved ??= initial();
    return {store: store as unknown as AppInstallationStore, plaintext: new Uint8Array(saved)};
  });
  /** The portal and the server's ledger. `approved`/`consentApproved` are the approval receipts' own fields. */
  const cp = {selected: false, approved: null as Receipt | null, consentApproved: null as Receipt | null, listing: [] as Record<string, unknown>[], grantsDeviceAccess: true,
    requests: [] as {method: string; path: string; body: Record<string, any> | undefined; bearer: string | undefined}[]};
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname + url.search, method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)), bearer = (init?.headers as Record<string, string>)?.authorization;
    cp.requests.push({method, path, body, bearer});
    const state = read(), consent = state.consentRequest;
    const selection = (requestId: string, challenge: string) => ({account_email: "person@example.test", account_selection_confirmed: true, request_id: requestId, account_id: account, connector_id: connector, device_id: state.deviceId, installation_id: state.installationId, kind: state.kind, challenge, approval_mode: "password-ak1", app_id: appId, app_origin: origin, expires_at: Date.now() + 600000});
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), {status});
    if (method === "POST" && path === "/v1/pairing-requests") {
      const asked = body!.installation;
      return reply(201, {pairing_id: asked.request_id, pairing_secret: asked.pairing_secret, verification_uri: `${cpOrigin}/pair/${asked.request_id}`, expires_in: 600, installation_device: true, app_id: appId, app_origin: origin, app_name: appName});
    }
    if (method === "POST" && path === `/v1/pairing-requests/${state.requestId}/attest`) return reply(200, {ok: true});
    if (method === "POST" && path === `/v1/pairing-requests/${state.requestId}/exchange`) {
      if (!cp.selected) return reply(202, {status: "pending"});
      const chosen = selection(state.requestId, "ab".repeat(32));
      if (!state.proof) return reply(202, {status: "account_selected", ...chosen});
      if (!cp.approved) return reply(202, {status: "awaiting_approval", ...chosen});
      return reply(200, {status: "paired", ...chosen, ...cp.approved, connector: {id: connector, name: appName}, token: `idev_${"a".repeat(43)}`,
        registration: {device_id: state.deviceId, sign_pk: hex(pk.signPublicKey), kem_pk: hex(pk.kemPublicKey), noise_pk: hex(pk.noisePublicKey)}});
    }
    if (method === "POST" && consent && path === `/v1/pairing-requests/${consent.requestId}/exchange`) {
      const chosen = selection(consent.requestId, "cd".repeat(32));
      return cp.consentApproved ? reply(200, {status: "scope_updated", ...chosen, ...cp.consentApproved}) : reply(202, {status: "awaiting_approval", ...chosen});
    }
    if (method === "GET" && url.pathname === "/v1/next/collections") {
      // The server adds `mode` to every row only when asked for it; the SDK keeps only "private".
      const withMode = url.search === "?include=file_actions,mode";
      return reply(200, {collections: cp.listing.map(row => ({...row, file_actions: [], ...(withMode ? {mode: row.collection_id === priv ? "private" : "cloud_copy"} : {})}))});
    }
    throw Error(`unexpected request ${method} ${path}`);
  }) as unknown as typeof fetch;
  // The device host: the real flow's own preparation, attestation and acknowledgement, with fixed keys.
  const custody = {...pk, envelope: new Uint8Array([6, 7])};
  const runtime = {deviceCustodyCurrent: (_pin: unknown, c: unknown) => c === custody, signCpEnrol: () => ({...pk, signature: new Uint8Array(64).fill(8)}), acknowledgeDeviceRegistration: vi.fn()} as unknown as AppWasmRuntime;
  const persistence = {pending: vi.fn(async () => {}), registered: vi.fn(async () => {})};
  vi.spyOn(AppWebCloudCopyHost, "openInstallationDevice").mockImplementation(async p => {
    await p.signIn.prepareOriginalDevice(p.installation);
    const parts = {runtime, custody, persistence, installation: p.installation} as unknown as Parameters<typeof p.signIn.attest>[0];
    const host = {attestInstallation: () => p.signIn.attest(parts), completeInstallationSignIn: () => p.signIn.acknowledge(parts), close: async () => {}};
    if (p.signIn.view().state === "paired") await host.completeInstallationSignIn();
    return host as unknown as AppWebCloudCopyHost;
  });
  vi.spyOn(ownership, "acquireAppInstallationLease").mockImplementation(async () => ({release: async () => {}}));
  vi.spyOn(ownership, "acquireAppReplicaLease").mockImplementation(async () => ({release: async () => {}}));
  const openCollection = vi.fn(async (_p: {collection: {collectionId: string}}) => ({state: "ready" as const, connection: {name: "held collection"}, close: async () => {}}));
  const navigatePortal = vi.fn(), closePortal = vi.fn();
  const openPortal = vi.fn<() => AppWebSignInPortal>(() => ({navigate: navigatePortal, close: closePortal}));
  const parent = new AbortController();
  const session = new AppWebSignInSession({appId, appName, origin, cpOrigin, environment: "production", release, signal: parent.signal, locks: undefined, fetch: request,
    loadRuntime: async () => Uint8Array.of(1), openPortal, openCollection: openCollection as never, autoSelect: options.autoSelect ?? "never",
    // What the application Worker passes for an app that declares offline.replica.
    freshRequestedCreateCollections: true, freshRequestedPrivateDevice: options.declaresPrivateDevice ?? true});
  /** One approval read, as a foregrounded tab makes it. */
  const tick = async () => {
    session.setForeground(false); session.setForeground(true);
    await vi.waitFor(() => expect((session as unknown as {pending: unknown}).pending).toBeNull());
  };
  const until = async (done: () => boolean) => { for (let turn = 0; turn < 8 && !done(); turn++) await tick(); expect(done(), JSON.stringify(session.getSnapshot())).toBe(true); };
  const paths = (method: string) => cp.requests.filter(r => r.method === method).map(r => r.path);
  /** START, the person picks the account, the device attests; the approval is still open. */
  const toApproval = async () => {
    await session.start(); expect(session.getSnapshot().status).toBe("signed_out");
    await session.authorize(); cp.selected = true;
    await until(() => session.getSnapshot().signIn?.state === "awaiting_approval");
    expect(session.getSnapshot()).toMatchObject({status: "authorizing", problem: null});
  };
  return {session, cp, read, tick, until, paths, toApproval, openCollection, navigatePortal, closePortal, close: async () => { await session.close(); parent.abort(); }};
}

describe("installation sign-in with Private device access, from START", () => {
  it("a Private-only approval carries no selection: signed in, in the chooser, the collection listed as Private", async () => {
    const f = fixture();
    await f.toApproval();
    expect(f.cp.requests[0]).toMatchObject({method: "POST", path: "/v1/pairing-requests", body: {installation: {requested_private_device: true, requested_create_collections: true}}});
    // The portal sends no selection for device access alone, and Connect's receipt names none.
    f.cp.approved = {collection_ids: [], create_collections: false, private_device_collection_ids: [priv]}; f.cp.listing = [rows.priv];
    await f.until(() => f.session.getSnapshot().signIn?.state === "paired");
    const snapshot = f.session.getSnapshot();
    expect(snapshot).toMatchObject({status: "unselected", problem: null, selectedCollectionId: null});
    expect(snapshot.signIn).toMatchObject({state: "paired", collectionIds: [priv], privateDeviceCollectionIds: [priv]});
    expect(snapshot.signIn!.collectionSelection ?? null).toBeNull();
    expect(snapshot.collections).toMatchObject([{collectionId: priv, displayName: "Private notes", role: "owner", mode: "private"}]);
    expect(f.read()).toMatchObject({token: `idev_${"a".repeat(43)}`, privateDeviceCollectionIds: [priv]}); expect(f.read()).not.toHaveProperty("collectionSelection");
    expect(f.paths("GET")).toEqual(["/v1/next/collections?include=file_actions,mode"]);
    expect(f.closePortal).toHaveBeenCalledOnce(); expect(f.openCollection).not.toHaveBeenCalled();
    // The chooser's pick opens it like any other collection.
    await f.session.select(priv);
    expect(f.session.getSnapshot()).toMatchObject({status: "ready", selectedCollectionId: priv});
    expect(f.openCollection).toHaveBeenCalledOnce(); expect(f.openCollection.mock.calls[0]![0]).toMatchObject({collection: {collectionId: priv, mode: "private"}, setupPolicy: "explicit"});
    await f.close();
  });
  it("with the default auto-select, a sole Private device collection opens as a sole cloud copy does", async () => {
    const f = fixture({autoSelect: "only"});
    await f.toApproval();
    f.cp.approved = {collection_ids: [], create_collections: false, private_device_collection_ids: [priv]}; f.cp.listing = [rows.priv];
    await f.until(() => f.session.getSnapshot().signIn?.state === "paired");
    expect(f.session.getSnapshot()).toMatchObject({status: "ready", problem: null, selectedCollectionId: priv});
    expect(f.session.getSnapshot().signIn!.collectionSelection ?? null).toBeNull();
    await f.close();
  });
  it("a mixed approval keeps its cloud-copy selection: the pick opens, the Private collection is listed beside it", async () => {
    const f = fixture({autoSelect: "only"});
    await f.toApproval();
    f.cp.approved = {selected_collection_id: cloud, created_collection_ids: [], collection_ids: [cloud], create_collections: false, private_device_collection_ids: [priv]}; f.cp.listing = [rows.cloud, rows.priv];
    await f.until(() => f.session.getSnapshot().signIn?.state === "paired");
    const snapshot = f.session.getSnapshot();
    expect(snapshot).toMatchObject({status: "ready", problem: null, selectedCollectionId: cloud});
    expect(snapshot.signIn).toMatchObject({collectionIds: [cloud, priv], privateDeviceCollectionIds: [priv], collectionSelection: {selectedCollectionId: cloud, createdCollectionIds: []}});
    expect(snapshot.signIn!.collectionSelection!.requestId).toBe(snapshot.signIn!.requestId);
    expect(snapshot.collections.map(c => [c.collectionId, c.mode])).toEqual([[cloud, undefined], [priv, "private"]]);
    expect(f.openCollection).toHaveBeenCalledOnce(); expect(f.openCollection.mock.calls[0]![0]).toMatchObject({collection: {collectionId: cloud}});
    expect(f.paths("GET")).toEqual(["/v1/next/collections?include=file_actions,mode"]);
    await f.close();
  });
  it.each([
    ["names cloud copies but no selection", {collection_ids: [cloud], create_collections: false}, true],
    ["names nothing at all", {collection_ids: [], create_collections: false}, true],
    ["names a Private device collection for an app that never asked", {collection_ids: [], create_collections: false, private_device_collection_ids: [priv]}, false],
  ] as const)("a receipt without a selection stays refused when it %s", async (_name, approved, declaresPrivateDevice) => {
    const f = fixture({declaresPrivateDevice});
    await f.toApproval();
    f.cp.approved = {...approved}; f.cp.listing = [rows.cloud, rows.priv];
    await f.until(() => f.session.getSnapshot().status !== "authorizing");
    expect(f.session.getSnapshot()).toMatchObject({status: "blocked", problem: "response", selectedCollectionId: null});
    expect(f.session.getSnapshot().collections).toEqual([]); expect(f.paths("GET")).toEqual([]); expect(f.openCollection).not.toHaveBeenCalled();
    await f.close();
  });
  it("a Private-only re-consent carries no selection: back in the chooser, the collection added as Private", async () => {
    const f = fixture();
    await f.toApproval();
    // First sign-in: one cloud copy, picked in the portal.
    f.cp.approved = {selected_collection_id: cloud, created_collection_ids: [], collection_ids: [cloud], create_collections: false}; f.cp.listing = [rows.cloud];
    await f.until(() => f.session.getSnapshot().signIn?.state === "paired");
    expect(f.session.getSnapshot()).toMatchObject({status: "unselected", problem: null});
    expect(f.session.getSnapshot().collections.map(c => c.collectionId)).toEqual([cloud]);
    // No Private device scope yet: the listing is the request every SDK already sends.
    expect(f.paths("GET")).toEqual(["/v1/next/collections?include=file_actions"]);
    const firstRequest = f.session.getSnapshot().signIn!.requestId;

    // Add a collection: the person chooses only the Private one, for device access.
    await f.session.authorize();
    const consent = f.read().consentRequest;
    expect(f.cp.requests.filter(r => r.path === "/v1/pairing-requests").at(-1)).toMatchObject({method: "POST", bearer: `Bearer idev_${"a".repeat(43)}`,
      body: {installation: {request_id: consent.requestId, reconsent: true, requested_private_device: true}}});
    await f.tick(); expect(f.session.getSnapshot()).toMatchObject({status: "authorizing", problem: null});
    f.cp.consentApproved = {added_collection_ids: [], approved_create_collections: false, added_private_device_collection_ids: [priv]}; f.cp.listing = [rows.cloud, rows.priv];
    await f.until(() => f.session.getSnapshot().status !== "authorizing");
    const snapshot = f.session.getSnapshot();
    expect(snapshot).toMatchObject({status: "unselected", problem: null, selectedCollectionId: null});
    expect(snapshot.signIn).toMatchObject({state: "paired", requestId: firstRequest, collectionIds: [cloud, priv], privateDeviceCollectionIds: [priv]});
    // This approval picked nothing, and the first sign-in's pick is not this request's: none is on record.
    expect(snapshot.signIn!.collectionSelection ?? null).toBeNull(); expect(f.read()).not.toHaveProperty("collectionSelection");
    expect(snapshot.collections.map(c => [c.collectionId, c.mode])).toEqual([[cloud, undefined], [priv, "private"]]);
    expect(f.paths("GET").at(-1)).toBe("/v1/next/collections?include=file_actions,mode");
    expect(f.closePortal).toHaveBeenCalledTimes(2); expect(f.openCollection).not.toHaveBeenCalled();
    await f.close();
  });
  it("a re-consent that added nothing and picked nothing stays refused", async () => {
    const f = fixture();
    await f.toApproval();
    f.cp.approved = {selected_collection_id: cloud, created_collection_ids: [], collection_ids: [cloud], create_collections: false}; f.cp.listing = [rows.cloud];
    await f.until(() => f.session.getSnapshot().signIn?.state === "paired");
    await f.session.authorize();
    f.cp.consentApproved = {added_collection_ids: [], approved_create_collections: false, added_private_device_collection_ids: []};
    await f.until(() => f.session.getSnapshot().status !== "authorizing");
    expect(f.session.getSnapshot()).toMatchObject({problem: "response"});
    expect(f.session.getSnapshot().signIn).not.toHaveProperty("privateDeviceCollectionIds");
    await f.close();
  });
});
