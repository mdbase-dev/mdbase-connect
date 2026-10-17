import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
import { appCollectionControlClient, attachAppCollectionControl, type AppCollectionSetupTurn } from "../src/app-host/collection-control.js";

const scope = {account: "11111111-1111-4111-8111-111111111111", installation: "22222222-2222-4222-8222-222222222222", collection: "33333333-3333-4333-8333-333333333333"};
const digest = "sha256:" + "ab".repeat(32);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("a detached tab's late prepare cannot resurrect ownership and strand the next tab", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const life = new AbortController(), setupTurn: AppCollectionSetupTurn = {owner: null};
  const journal = new AppCollectionSetupJournal({scope, databaseName: "late-prepare", applicationNamespace: "test", appOrigin: "https://app.test", cpOrigin: "https://cp.test", isCurrent: () => true});
  const binding = {scope, generation: crypto.randomUUID()};
  const tab = () => {
    const channel = new MessageChannel();
    const server = attachAppCollectionControl(channel.port1, binding, {journal, setupTurn, signal: life.signal, isCurrent: () => true, assess: () => {}, foreground: () => {}, onProtocolFailure: () => {}});
    const client = appCollectionControlClient(channel.port2, binding, {signal: life.signal, isCurrent: () => true, onClose: () => {}});
    return {server, client};
  };
  const first = tab(), next = tab();
  let finish!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const committed = new Promise<void>(resolve => { reached = resolve; });
  const prepare = journal.prepareResources.bind(journal);
  vi.spyOn(journal, "prepareResources").mockImplementation(async (plan, signal) => {
    const intent = await prepare(plan, signal);
    reached(); await held;
    return intent;
  });
  try {
    const work = first.client.journal.prepareResources({assessmentDigest: digest, provisionDigest: digest, packs: [{id: "sample", version: "1", digest}], resourceOps: [{kind: "resource_put", path: "_types/sample.md", doc: "type", mustNotExist: true}], resourceReadback: [{path: "_types/sample.md", doc: "type"}], sources: []}, life.signal);
    const outcome = work.catch(error => error);
    await committed;
    const drain = first.server.close();
    expect(await outcome).toMatchObject({reason: "outcome_unknown"});
    finish(); await drain;
    expect(setupTurn.owner).toBeNull();
    // Recovery sees the original durable intent, never a permanently busy turn.
    await expect(next.client.journal.load(life.signal)).resolves.toMatchObject({phase: "prepared"});
  } finally {
    finish(); first.client.close(); next.client.close();
    await Promise.all([first.server.close(), next.server.close()]);
    life.abort(); journal.close();
  }
});
