import {afterEach, describe, expect, it, vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {eraseAppInstallationData, eraseAppCollectionAccess} from "../src/app-host/sign-out-erase.js";
import {idbLogTokenCache, LOG_TOKEN_DATABASE} from "../src/app-host/log-token-cache.js";

const account = "11111111-1111-4111-8111-111111111111", connector = "22222222-2222-4222-8222-222222222222";
const device = "33333333-3333-4333-8333-333333333333", installation = "44444444-4444-4444-8444-444444444444";
const app = "55555555-5555-4555-8555-555555555555", collection = "66666666-6666-4666-8666-666666666666";
const cpOrigin = "https://cp.example.test", owner = "bundle:notes:scope:owned-reference";
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
async function database(name: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }); db.close();
}

describe("isolated single-collection recovery actor erasure", () => {
  it("default (non-namespaced) sign-out keeps legacy whole-cache erasure",async()=>{
    vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("navigator",{});
    const cache=idbLogTokenCache()!,now=Date.now(),otherDevice="77777777-7777-4777-8777-777777777777";
    const ownKey=[cpOrigin,"https://log.example.test",connector,device,collection].join(" ");
    const otherKey=[cpOrigin,"https://log.example.test",connector,otherDevice,collection].join(" ");
    await cache.write(ownKey,{value:"own-test-token",expires:now+120_000});
    await cache.write(otherKey,{value:"other-test-token",expires:now+120_000});
    expect(await cache.read(otherKey,now)).not.toBeNull();
    expect(await eraseAppInstallationData({cpOrigin,appId:app,owner,accountId:account,connectorId:connector,deviceId:device,installationId:installation,collectionIds:[collection],databases:[]})).toEqual({ledger:true,complete:true});
    expect(await cache.read(otherKey,now)).toBeNull();
  });

  it("retiring an original scope preserves its installation custody, token cache, journals and another collection", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const key = `mdbase.app.device-keys.v1.${[account, connector, device, installation].map(value => value.replaceAll("-", "")).join(".")}`;
    const outcome = `mdbase.app.cloud-copy-outcome.v1.${[account, connector, device, installation].join(".")}.${collection}.join`;
    const otherOutcome = outcome.replace(collection, "77777777-7777-4777-8777-777777777777");
    for(const name of [key, outcome, otherOutcome, "shared-setup-journal", LOG_TOKEN_DATABASE])await database(name);
    const removed: string[] = [];
    vi.stubGlobal("navigator", {storage: {getDirectory: async () => ({removeEntry: async (name: string) => {removed.push(name);}})}});
    expect(await eraseAppCollectionAccess({cpOrigin, appId: app, accountId: account, connectorId: connector, deviceId: device, installationId: installation, collectionIds: [collection], databases: []}, collection)).toBe(true);
    const remaining = (await indexedDB.databases()).map(value => value.name);
    expect(remaining).toEqual(expect.arrayContaining([key, otherOutcome, "shared-setup-journal", LOG_TOKEN_DATABASE]));
    expect(remaining).not.toContain(outcome);
    expect(removed).toEqual([`.mdbase-app-${account}-${installation}-${collection}`]);
  });
  it("erases only this actor's ledger, custody/outcomes and replica; preserves original/global stores and other actor", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const cp = encodeURIComponent(cpOrigin);
    const scoped = `mdbase.app.installation.v2.${cp}.${encodeURIComponent(owner)}.${app}`;
    const original = `mdbase.app.installation.v2.${cp}.${encodeURIComponent("bundle:notes")}.${app}`;
    const unlabelled = `mdbase.app.installation.v1.${cp}.${app}`, journal = "shared-setup-journal";
    const prefix = [account, connector, device, installation].join(".");
    const outcome = `mdbase.app.cloud-copy-outcome.v1.${prefix}.${collection}.join`;
    const otherOutcome = outcome.replace(installation, "77777777-7777-4777-8777-777777777777");
    const key = `mdbase.app.device-keys.v1.${[account, connector, device, installation].map(value => value.replaceAll("-", "")).join(".")}`;
    for(const name of [scoped, original, unlabelled, journal, LOG_TOKEN_DATABASE, outcome, otherOutcome, key])await database(name);
    const ownReplica = `.mdbase-app-${account}-${installation}-${collection}`, otherReplica = ownReplica.replace(installation, "77777777-7777-4777-8777-777777777777");
    const removed: string[] = [];
    vi.stubGlobal("navigator", {storage: {getDirectory: async () => ({keys: async function*(){yield ownReplica; yield otherReplica;}, removeEntry: async (name: string) => {removed.push(name);}})}});
    const result = await eraseAppInstallationData({cpOrigin, appId: app, owner, accountId: account, connectorId: connector, deviceId: device, installationId: installation,
      collectionIds: [collection], databases: [journal], isolated: true});
    expect(result).toEqual({ledger: true, complete: true});
    const remaining = (await indexedDB.databases()).map(value => value.name);
    expect(remaining).toEqual(expect.arrayContaining([original, unlabelled, journal, LOG_TOKEN_DATABASE, otherOutcome]));
    for(const name of [scoped, outcome, key])expect(remaining).not.toContain(name);
    expect(removed).toEqual([ownReplica]);
  });
});
