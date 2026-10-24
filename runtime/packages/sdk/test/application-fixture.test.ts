import {afterEach, describe, expect, it, vi} from "vitest";
import {connect, MdbasePeopleClient, TimersApi, type MdbaseClient, type MdbaseApplicationConnection, type MdbaseApplicationSnapshot} from "../src/index.js";
import {createApplicationFixture, MemoryReplica} from "../src/testing/index.js";

const declaration = {id: "fixture.application", name: "Fixture", origin: "https://fixture.example", environment: "lab" as const, manifest: {id: "dev.fixture"}};
function snapshot(patch: Partial<MdbaseApplicationSnapshot> = {}): MdbaseApplicationSnapshot {
  const facet = {checking: false, assessment: null, problem: null};
  return {status: "signed_out", signIn: null, collections: [], selectedCollectionId: null, problem: null, timing: null,
    readiness: {...facet, facets: {capabilities: facet, contracts: facet, configuration: facet, files: facet, people: facet, notifications: facet}},
    selection: {state: "none", requested: {collectionId: null, source: "none", displayName: null, approved: false}, usable: null, problem: null}, ...patch};
}
const clients: MdbaseClient[] = [];
afterEach(() => {for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks();});
async function native() {
  const replica = new MemoryReplica({confirmDelayMs: 0});
  const seeded = replica.seed({path: "fixture.md", body: "Original native record"});
  const records = await connect({connector: replica.connector(), app: {name: "fixture-test", version: "test"}, reconnect: false});
  clients.push(records);
  const request = vi.fn(async () => {throw new Error("Fixture must not request metadata");});
  const people = new MdbasePeopleClient(records, {collection: records.collection, request, isCurrent: () => true});
  const timerRequest = vi.fn(async () => {throw new Error("Fixture must not request timers");});
  const timers = new TimersApi({list: timerRequest, put: timerRequest, cancel: timerRequest, reconcile: timerRequest,
    registerWebPush: timerRequest, unregisterWebPush: timerRequest, registerFcm: timerRequest, unregisterFcm: timerRequest});
  const isCurrent = vi.fn(() => true);
  const connection: MdbaseApplicationConnection = {id: records.collection, displayName: "Fixture native collection",
    scope: {account: "fixture-account", installation: "fixture-installation", collection: records.collection},
    generation: "fixture-generation", records, files: records.files, people, timers, isCurrent};
  return {records, connection, request, timerRequest, seeded};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

describe("public application fixture (metadata stand-in, not runtime evidence)", () => {
  it("retains the same full borrowed native client, files and people without freezing/closing them", async () => {
    const h = await native();
    const close = vi.spyOn(h.records, "close");
    const initialSnapshot = snapshot({selectedCollectionId: h.records.collection});
    const fixture = createApplicationFixture({declaration, connections: [h.connection], initialSnapshot});
    expect(fixture.entry.connection(h.records.collection)?.scope).toEqual(h.connection.scope);
    expect(fixture.entry.connection(h.records.collection)?.generation).toBe(h.connection.generation);
    expect(fixture.entry.connection(h.records.collection)?.displayName).toBe(h.connection.displayName);
    expect(fixture.entry.connection(h.records.collection)?.records).toBe(h.records);
    expect(fixture.entry.connection(h.records.collection)?.files).toBe(h.records.files);
    expect(fixture.entry.connection(h.records.collection)?.people).toBe(h.connection.people);
    expect(fixture.entry.connection(h.records.collection)?.timers).toBe(h.connection.timers);
    expect(Object.isFrozen(h.records)).toBe(false);
    const record = await h.records.get({path: "fixture.md"}, {body: true});
    expect(record.body).toBe("Original native record");
    // A fixture-selected client does not manufacture semantic readiness.
    expect(fixture.entry.application().getSnapshot().readiness.assessment).toBeNull();
    await fixture.entry.application().close();
    expect(close).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.timerRequest).not.toHaveBeenCalled();
    expect(h.records.link).toBe("open");
    expect(fixture.entry.connection(h.records.collection)).toBeNull();
  });
  it("copies connection arrays, checks duplicate/binding/files identity, and can replace fixture lookup", async () => {
    const h = await native();
    const connections = [h.connection];
    const fixture = createApplicationFixture({declaration, connections, initialSnapshot: snapshot({selectedCollectionId: h.records.collection})});
    connections.splice(0);
    expect(fixture.entry.connection(h.records.collection)?.records).toBe(h.records);
    expect(() => fixture.controls.setConnections([h.connection, h.connection])).toThrow("Duplicate fixture connection");
    expect(() => fixture.controls.setConnections([{...h.connection, id: "other-collection"}])).toThrow("original native collection");
    const peer = await native();
    expect(() => fixture.controls.setConnections([{...h.connection, files: peer.records.files}])).toThrow("original native collection");
    fixture.controls.setConnections([]);
    expect(fixture.entry.connection(h.records.collection)).toBeNull();
  });
  it("publishes through no-argument notifications and releases only subscriber scope", async () => {
    const fixture = createApplicationFixture({declaration, connections: [], initialSnapshot: snapshot()});
    const app = fixture.entry.application();
    const listener = vi.fn();
    const unsubscribe = app.subscribe(listener);
    const next = snapshot({status: "unselected", collections: [{collectionId: "fixture-collection", displayName: "Fixture", role: "owner"}]});
    fixture.controls.publishSnapshot(next);
    expect(listener).toHaveBeenCalledWith();
    expect(app.getSnapshot()).not.toBe(next);
    await app.select("fixture-collection");
    expect(app.getSnapshot().selectedCollectionId).toBe("fixture-collection");
    expect(app.getSnapshot().readiness.assessment).toBeNull();
    await app.forget("fixture-collection");
    expect(app.getSnapshot().collections).toEqual([]);
    expect(app.getSnapshot().selectedCollectionId).toBeNull();
    const notifications = listener.mock.calls.length;
    unsubscribe(); unsubscribe();
    fixture.controls.publishSnapshot(snapshot());
    expect(listener).toHaveBeenCalledTimes(notifications);
  });
  it("records gesture dispatch and original signals; a handler can expose a blocked action", async () => {
    const fixture = createApplicationFixture({declaration, connections: [], initialSnapshot: snapshot()});
    const app = fixture.entry.application();
    const handler = vi.fn(() => {throw new Error("Fixture blocked popup");});
    fixture.controls.setHandler("authorize", handler);
    const scope = new AbortController();
    const action = app.authorize({signal: scope.signal});
    expect(handler).toHaveBeenCalledOnce(); // BEFORE any await
    expect(fixture.controls.observedActions()[0]?.signal).toBe(scope.signal);
    await expect(action).rejects.toThrow("Fixture blocked popup");
    expect(app.getSnapshot().status).toBe("signed_out");
    app.setForeground(false);
    expect(fixture.controls.observedActions().at(-1)).toEqual({action: "setForeground", active: false});
    expect(Object.isFrozen(fixture.controls.observedActions())).toBe(true);
  });
  it("caller cancellation rejects late completion without publishing its snapshot", async () => {
    const fixture = createApplicationFixture({declaration, connections: [], initialSnapshot: snapshot()});
    const app = fixture.entry.application();
    const job = deferred<MdbaseApplicationSnapshot>();
    fixture.controls.setHandler("start", () => job.promise);
    const scope = new AbortController();
    const started = app.start({signal: scope.signal});
    scope.abort();
    job.resolve(snapshot({status: "ready"}));
    await expect(started).rejects.toMatchObject({name: "AbortError"});
    expect(app.getSnapshot().status).toBe("signed_out");
    const calls = fixture.controls.observedActions().length;
    await expect(app.start({signal: scope.signal})).rejects.toMatchObject({name: "AbortError"});
    expect(fixture.controls.observedActions()).toHaveLength(calls);
  });
  it("a late retired selection cannot replace a newer controller snapshot", async () => {
    const fixture = createApplicationFixture({declaration, connections: [], initialSnapshot: snapshot()});
    const job = deferred<MdbaseApplicationSnapshot>();
    fixture.controls.setHandler("select", () => job.promise);
    const selected = fixture.entry.application().select("old");
    fixture.controls.publishSnapshot(snapshot({selectedCollectionId: "replacement"}));
    job.resolve(snapshot({selectedCollectionId: "old"}));
    await selected;
    expect(fixture.entry.application().getSnapshot().selectedCollectionId).toBe("replacement");
  });
  it("failed close keeps original metadata/client lookup; retry closes only fixture presentation", async () => {
    const h = await native();
    const fixture = createApplicationFixture({declaration, connections: [h.connection], initialSnapshot: snapshot({selectedCollectionId: h.records.collection})});
    const remove = fixture.controls.setHandler("close", () => {throw new Error("Fixture close failed");});
    const app = fixture.entry.application();
    const listener = vi.fn(); app.subscribe(listener);
    await expect(app.close()).rejects.toThrow("Fixture close failed");
    expect(fixture.entry.connection(h.records.collection)?.records).toBe(h.records);
    fixture.controls.publishSnapshot(snapshot({selectedCollectionId: h.records.collection}));
    expect(listener).toHaveBeenCalledOnce();
    remove();
    await app.close(); await app.close();
    expect(fixture.controls.observedActions().filter(call => call.action === "close")).toHaveLength(2);
    await expect(app.start()).rejects.toThrow("closed");
    expect(h.records.link).toBe("open");
  });
  it("assess/configure return only supplied metadata and never invent readiness", async () => {
    const h = await native();
    const fixture = createApplicationFixture({declaration, connections: [h.connection], initialSnapshot: snapshot({selectedCollectionId: h.records.collection})});
    const app = fixture.entry.application();
    const caller = new AbortController();
    expect((await app.assess({signal: caller.signal})).assessment).toBeNull();
    expect((await app.configure({signal: caller.signal})).readiness.assessment).toBeNull();
    const readiness = snapshot().readiness;
    const configured = snapshot({selectedCollectionId: h.records.collection, readiness: {...readiness, assessment: {status: "setup_required", problem: null}}});
    fixture.controls.setHandler("configure", () => configured);
    await app.configure();
    expect((await app.assess()).assessment?.status).toBe("setup_required");
    expect(fixture.controls.observedActions().slice(0, 2).map(call => call.signal)).toEqual([caller.signal, caller.signal]);
    expect(h.records.link).toBe("open");
    expect(h.request).not.toHaveBeenCalled(); expect(h.timerRequest).not.toHaveBeenCalled();
  });
  it("retires issued fixture connections on replacement, deselection/reselection and fixture close", async () => {
    const h = await native();
    const fixture = createApplicationFixture({declaration, connections: [h.connection], initialSnapshot: snapshot({selectedCollectionId: h.records.collection})});
    const old = fixture.entry.connection(h.records.collection);
    expect(old?.isCurrent()).toBe(true);
    fixture.controls.setConnections([h.connection]);
    expect(old?.isCurrent()).toBe(false);
    const replacement = fixture.entry.connection(h.records.collection);
    expect(replacement?.records).toBe(h.records);
    expect(replacement?.isCurrent()).toBe(true);
    await fixture.entry.application().clearSelection();
    expect(replacement?.isCurrent()).toBe(false);
    await fixture.entry.application().select(h.records.collection);
    const reselected = fixture.entry.connection(h.records.collection);
    expect(reselected?.isCurrent()).toBe(true);
    expect(old?.isCurrent()).toBe(false); expect(replacement?.isCurrent()).toBe(false);
    fixture.controls.close(); fixture.controls.close();
    expect(reselected?.isCurrent()).toBe(false);
    expect(fixture.entry.connection(h.records.collection)).toBeNull();
    expect(h.records.link).toBe("open");
    expect(fixture.controls.observedActions().some(call => call.action === "close")).toBe(false);
  });
  it("subscription teardown is isolated even when two owners pass the same function", () => {
    const fixture = createApplicationFixture({declaration, connections: [], initialSnapshot: snapshot()});
    const listener = vi.fn();
    const app = fixture.entry.application();
    const stopA = app.subscribe(listener); const stopB = app.subscribe(listener);
    stopA(); fixture.controls.publishSnapshot(snapshot());
    expect(listener).toHaveBeenCalledOnce();
    stopB(); fixture.controls.publishSnapshot(snapshot());
    expect(listener).toHaveBeenCalledOnce();
  });
  it("does not duplicate a pending close or accept a new selection while closing", async () => {
    const fixture = createApplicationFixture({declaration, connections: [], initialSnapshot: snapshot()});
    const job = deferred<void>();
    fixture.controls.setHandler("close", () => job.promise);
    const app = fixture.entry.application();
    const first = app.close(); const second = app.close();
    expect(second).toBe(first);
    await expect(app.select("replacement")).rejects.toThrow("closing");
    job.resolve(); await first;
    expect(fixture.controls.observedActions().filter(call => call.action === "close")).toHaveLength(1);
  });
});
