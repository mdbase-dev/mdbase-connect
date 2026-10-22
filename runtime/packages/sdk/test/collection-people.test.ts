import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MdbaseClient } from "../src/client.js";
import type { Session } from "../src/session.js";
import type { ContractQueryResult } from "../src/contract-query.js";
import { mdbaseError, MdbaseError } from "../src/errors.js";
import type { PeopleAuthority } from "../src/people.js";
import { toFmMap } from "../src/values.js";
import { AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
import { appCollectionControlClient, attachAppCollectionControl } from "../src/app-host/collection-control.js";
import { collectionPeopleDto, collectionPeopleError, createAppCollectionPeople } from "../src/app-host/collection-people.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = {account: id(1), installation: id(2), collection: id(3)};
const identity = {issuer: "https://Provider.example/exact", subject: "account_exact", name: "Account Name", account_id: id(1), person_settings_url: "https://cp.example/settings/person"};
const member = {...identity, role: "owner"};
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
function page(n: number, name: string, cursor?: string): ContractQueryResult {
  return {version: 1, contractDigest: "a".repeat(64), records: [{id: id(n), implementations: [{typeName: "custom_person", fields: toFmMap({name, identities: [{issuer: identity.issuer, subject: identity.subject}]}), issues: []}]}],
    page: {records: [{id: id(n), path: `Contacts/mapped-${n}.md`, revision: "b".repeat(64), types: ["custom_person"], frontmatter: new Map(), state: {state: "confirmed", confirmedSeq: 1}}], complete: true, asOf: 7, hasMore: !!cursor, ...(cursor ? {cursor} : {})}};
}
function fixture(options: {enabled?: boolean; worker?: boolean} = {}) {
  const parent = new AbortController(), ui = new AbortController(), channel = new MessageChannel();
  const binding = {scope, generation: crypto.randomUUID()};
  let workerCurrent = true, uiCurrent = true, authorityCurrent = true;
  const authority: PeopleAuthority = {collection: scope.collection, isCurrent: () => authorityCurrent,
    request: vi.fn(async resource => resource === "identity" ? identity : {members: [member]})};
  const journal = new AppCollectionSetupJournal({scope, databaseName: "people-original-journal", applicationNamespace: "example", appOrigin: "https://app.example", cpOrigin: "https://cp.example", isCurrent: () => workerCurrent && !parent.signal.aborted});
  const onClose = vi.fn(), bad = vi.fn();
  const server = attachAppCollectionControl(channel.port1, binding, {journal, signal: parent.signal, isCurrent: () => workerCurrent,
    assess: vi.fn(), foreground: vi.fn(), onProtocolFailure: bad, ...(options.worker === false ? {} : {peopleAuthority: authority})});
  const control = appCollectionControlClient(channel.port2, binding, {signal: ui.signal, isCurrent: () => uiCurrent, onClose, people: options.enabled !== false});
  let session = {closed: false, hello: {collection: scope.collection}} as Session;
  // Explicit native projection stand-in; actual SDK directory and both control
  // MessagePorts are exercised. Not a native/CP/browser/custody qualification.
  const native = {queryContract: vi.fn(async () => page(11, "Mapped Person")), readyForRead: vi.fn(async () => session), currentSession: () => session};
  const client = native as unknown as MdbaseClient;
  const people = options.enabled === false ? undefined : createAppCollectionPeople(client, control);
  cleanup.push(async () => {ui.abort(); parent.abort(); control.close(); await server.close(); journal.close();});
  return {channel, binding, parent, ui, authority, journal, server, control, native, client, people: people!, bad, onClose,
    loseWorker: () => {workerCurrent = false;}, loseUi: () => {uiCurrent = false;}, loseAuthority: () => {authorityCurrent = false;}, replaceSession: () => {session = {closed: false, hello: {collection: scope.collection}} as Session;}};
}

describe("original collection people control bridge", () => {
  it("preserves old journal verbs and does not advertise people on an old handoff", async () => {
    const f = fixture({enabled: false});
    expect(f.control.peopleAuthority).toBeUndefined();
    expect(() => createAppCollectionPeople(f.client, f.control)).toThrow(MdbaseError);
    expect(await f.control.journal.load(f.ui.signal)).toBeNull();
  });
  it("explicit unsupported Worker does not infer identity from native records", async () => {
    const f = fixture({worker: false});
    await expect(f.people.current()).rejects.toMatchObject({code: "upgrade_required", reason: "people_unsupported"});
    expect(f.authority.request).not.toHaveBeenCalled();
  });
  it("shares ONE occupied slot with journal and retains cancellation until original reply", async () => {
    const f = fixture(), caller = new AbortController();
    let release!: (value: unknown) => void;
    vi.mocked(f.authority.request).mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    const pending = f.people.current({signal: caller.signal});
    await vi.waitFor(() => expect(f.authority.request).toHaveBeenCalledOnce());
    try {
      await expect(f.people.members()).rejects.toMatchObject({code: "unavailable", reason: "people_busy"});
      await expect(f.control.journal.load(f.ui.signal)).rejects.toMatchObject({reason: "busy"});
      caller.abort(); await expect(pending).rejects.toMatchObject({reason: "people_fenced"});
      await expect(f.people.current()).rejects.toMatchObject({reason: "people_busy"});
      expect(f.authority.request).toHaveBeenCalledOnce();
    } finally {release(identity);}
    await vi.waitFor(async () => expect(await f.control.journal.load(f.ui.signal)).toBeNull());
    expect(await f.people.members()).toHaveLength(1);
  });
  it.each([0])("rechecks ORIGINAL caller at successful delivery cut %s", async depth => {
    const f = fixture(), caller = new AbortController(), receive = f.channel.port2.onmessage!;
    f.channel.port2.onmessage = event => {
      receive.call(f.channel.port2, event);
      if (event.data[4] === "result") {
        const abort = (n: number): void => {if (n === 0) caller.abort(); else queueMicrotask(() => abort(n - 1));};
        abort(depth);
      }
    };
    // Directory has public wrapper cuts beyond the proxy/current() boundary.
    // Existing engine preserves the original AbortError for caller cancellation.
    await expect(f.people.directory({members: "omit", signal: caller.signal})).rejects.toBeDefined();
    expect(caller.signal.aborted).toBe(true);
    expect(f.authority.request).toHaveBeenCalledOnce();
  });
  it("never sends an already aborted caller or one invalidated by prior selection", async () => {
    const f = fixture(), caller = new AbortController(); caller.abort();
    await expect(f.people.current({signal: caller.signal})).rejects.toBeDefined();
    f.loseUi(); await expect(f.people.current()).rejects.toMatchObject({reason: "people_fenced"});
    expect(f.authority.request).not.toHaveBeenCalled();
  });
  it.each(["authority", "parent"])("fences late metadata after original %s changes", async kind => {
    const f = fixture(); let release!: (value: unknown) => void;
    vi.mocked(f.authority.request).mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    const pending = f.people.current();
    await vi.waitFor(() => expect(f.authority.request).toHaveBeenCalledOnce());
    if (kind === "authority") f.loseAuthority();
    // Original adapter owner closes control when its parent stops, before native
    // teardown; the attachment itself does not mint another abort lifecycle.
    if (kind === "parent") {f.parent.abort(); void f.server.close();}
    release(identity);
    await expect(pending).rejects.toMatchObject({reason: "people_fenced"});
  });
  it("projects allowed fields only and preserves exact provider strings", async () => {
    const f = fixture(), sent = vi.spyOn(f.channel.port1, "postMessage");
    vi.mocked(f.authority.request).mockResolvedValueOnce({...identity, token: "not-a-real-token", sql: "private-backend", secret: {nested: true}});
    expect((await f.people.current()).issuer).toBe(identity.issuer);
    expect(sent.mock.calls[0]![0][5]).toEqual(identity);
    expect(JSON.stringify(sent.mock.calls)).not.toContain("not-a-real-token");
  });
  it.each(["permission", "unknown"])("optional members distinguishes original %s refusal", async kind => {
    const f = fixture();
    vi.mocked(f.authority.request).mockImplementation(async resource => {
      if (resource === "identity") return identity;
      if (kind === "unknown") throw Error("private adapter detail");
      throw mdbaseError(kind === "unavailable" ? "unavailable" : "forbidden", "private error", kind === "permission" ? "people_permission_declined" : "people_access");
    });
    if (kind === "permission") {
      expect(await f.people.directory()).not.toHaveProperty("members");
      await expect(f.people.directory({members: "require"})).rejects.toMatchObject({reason: "people_permission_declined"});
    } else await expect(f.people.directory()).rejects.toMatchObject({reason: "people_response"});
  });
  it.each(["generation", "malformedError"])("fails closed and settles original metadata waiter on %s reply", async kind => {
    const f = fixture(), send = f.channel.port1.postMessage.bind(f.channel.port1);
    vi.spyOn(f.channel.port1, "postMessage").mockImplementation((value: unknown) => {
      const packet = value as unknown[];
      if (packet[3] === 0) {send(value); return;}
      const changed = [...packet];
      if (kind === "generation") changed[2] = crypto.randomUUID();
      else {changed[4] = "error"; changed[5] = {code: "internal", reason: "not-allowed", message: "discard"};}
      send(changed);
    });
    await expect(f.people.current()).rejects.toMatchObject({reason: "people_fenced"});
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it("refuses the entire projected metadata packet above the ORIGINAL control budget", async () => {
    const f = fixture(); vi.mocked(f.authority.request).mockResolvedValueOnce({members: Array.from({length: 140}, () => ({...member, name: "x".repeat(4096)}))});
    await expect(f.people.members()).rejects.toMatchObject({reason: "people_response"});
    expect(await f.control.journal.load(f.ui.signal)).toBeNull();
  });
});

describe("bounded plain people DTOs", () => {
  it.each(["name", "issuer", "account", "role", "count", "utf8", "prototype", "getter", "holes"])("refuses %s without partial results or evaluating getters", kind => {
    let resource: "identity" | "members" = "identity", value: unknown = {...identity};
    const getter = vi.fn(() => "not-a-real-private-value");
    if (kind === "name") value = {...identity, name: " "};
    if (kind === "issuer") value = {...identity, issuer: "https://user:pass@example.test"};
    if (kind === "account") value = {...identity, account_id: "00000000-0000-0000-0000-000000000000"};
    if (kind === "role") {resource = "members"; value = {members: [{...member, role: "root"}]};}
    if (kind === "count") {resource = "members"; value = {members: Array.from({length: 1001}, () => member)};}
    if (kind === "utf8") value = {...identity, name: "é".repeat(2049)};
    if (kind === "prototype") value = Object.assign(Object.create({name: "inherited"}), identity);
    if (kind === "getter") Object.defineProperty(value, "sensitiveExtra", {get: getter});
    if (kind === "holes") {resource = "members"; value = {members: new Array(1)};}
    expect(() => collectionPeopleDto(resource, value)).toThrow(MdbaseError);
    expect(getter).not.toHaveBeenCalled();
  });
  it("accepts exact maximum UTF8 field and does not forward native paths/credential extras", () => {
    expect(collectionPeopleDto("identity", {...identity, name: "é".repeat(2048), path: "private-path", credential: "private"})).toEqual({...identity, name: "é".repeat(2048)});
  });
  it("hostile error properties cannot escape sanitizer or grant optional permission decline", () => {
    const error = mdbaseError("forbidden", "private", "people_permission_declined");
    expect(collectionPeopleError("identity", error)).toEqual({code: "forbidden", reason: "people_access"});
    const getter = vi.fn(() => {throw Error("private getter");}); Object.defineProperty(error, "code", {get: getter});
    expect(collectionPeopleError("members", error)).toEqual({code: "unavailable", reason: "people_response"});
  });
});
