import { isMdbaseError, MdbaseError } from "@mdbase-dev/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorPermissions } from "./gateway";
import { CollectionIndexController } from "./collection-index-controller";
import { backlinksFor } from "./links";
import type { EditorCollectionChange, NoteObservationSnapshot } from "./model";
import { NativeEditorGateway } from "./native-gateway";
import { outdatedPersonStarter } from "./person-setup";
import { closeNativeFixtures, readyFixture } from "./test/native-fixture";
import manifest from "../public/.well-known/mdbase-app.json";

const declaration = { id: manifest.id, name: manifest.name, origin: "https://editor.mdbase.dev", environment: "lab" as const, manifest };

const gateways: NativeEditorGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.dispose();
  closeNativeFixtures();
});

async function fixture(...args: Parameters<typeof readyFixture>) {
  const f = await readyFixture(...args);
  const gateway = new NativeEditorGateway(f.application, f.connection, declaration);
  gateways.push(gateway);
  return { ...f, gateway };
}

function seedNotes(replica: Parameters<NonNullable<Parameters<typeof readyFixture>[1]>>[0]) {
  replica.seed({ path: "notes/plan.md", types: ["note"], frontmatter: { title: "Plan" }, body: "# Plan\n" });
  replica.seed({ path: "notes/ideas.md", types: ["note"], frontmatter: { title: "Ideas" }, body: "# Ideas\n" });
}

async function settled(observation: { getSnapshot(): NoteObservationSnapshot }, predicate: (snapshot: NoteObservationSnapshot) => boolean) {
  await vi.waitFor(() => { expect(predicate(observation.getSnapshot())).toBe(true); });
}

describe("NativeEditorGateway over the public SDK (MemoryReplica, not LAB)", () => {
  it("can retire a borrowed scope before mounting without reading its closed hello", async () => {
    const f = await readyFixture();
    f.client.close();
    const gateway = new NativeEditorGateway(f.application, { ...f.connection, isCurrent: () => false }, declaration);
    gateways.push(gateway);
    expect(gateway.sessionSnapshot()).toEqual({ status: "unselected", connections: [] });
    gateway.dispose();
  });

  it("reports the original selected scope and maps only granted record capabilities", async () => {
    const f = await fixture();
    const snapshot = f.gateway.sessionSnapshot();
    expect(snapshot).toMatchObject({ status: "ready", connection: { collectionId: f.replica.collection, displayName: "Notes" } });
    const permissions = editorPermissions(snapshot.status === "ready" ? snapshot.connection : null);
    expect(permissions).toMatchObject({ canCreateNotes: true, canEditNotes: true, canRenameNotes: true, canDeleteNotes: true });
    expect(permissions).toMatchObject({ canManageTypes: true, canInstallTypes: true, canAttachFiles: true });
    expect(snapshot.status === "ready" && snapshot.connection.missingCapabilities).toBeFalsy();
    expect(f.gateway.selectConnection(f.replica.collection).collectionId).toBe(f.replica.collection);
    expect(() => f.gateway.selectConnection("another-collection")).toThrow("not ready");
    expect(await f.gateway.checkDirectAccess()).toBeNull();
  });

  it("a Viewer grant exposes no write operations or misleading access-update prompts", async () => {
    const f = await fixture({ capabilities: ["collection.read"], role: "viewer" });
    const snapshot = f.gateway.sessionSnapshot();
    const connection = snapshot.status === "ready" ? snapshot.connection : null;
    expect(editorPermissions(connection)).toMatchObject({
      canCreateNotes: false, canEditNotes: false, canRenameNotes: false, canDeleteNotes: false, canAttachFiles: false, canInstallTypes: false, canManageTypes: false
    });
    expect(connection?.missingCapabilities).toBeUndefined();
    const upload = vi.spyOn(f.client.files, "upload");
    await expect(f.gateway.uploadFile("attachments/a.txt", new Blob(["x"]))).rejects.toMatchObject({ reason: "read_only" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("uses live SDK membership and refuses mutations before local capture", async () => {
    const f = await fixture({}, seedNotes);
    const snapshot = f.application.getSnapshot();
    const setRole = (role: "viewer" | "editor") => f.controls.publishSnapshot({
      ...snapshot, collections: snapshot.collections.map((entry) => ({ ...entry, role }))
    });
    const changed = vi.fn();
    const stop = f.gateway.onSessionChange(changed);
    // The pinned SDK's Host hello reports Owner; membership is exposed separately.
    expect(f.client.hello.grant.role).not.toBe("viewer");
    setRole("viewer");
    const current = f.gateway.sessionSnapshot();
    expect(current.status === "ready" && current.connection.role).toBe("viewer");
    expect(editorPermissions(current.status === "ready" ? current.connection : null)).toMatchObject({
      canCreateNotes: false, canEditNotes: false, canRenameNotes: false,
      canDeleteNotes: false, canManageTypes: false, canInstallTypes: false, canAttachFiles: false
    });
    expect(changed).toHaveBeenLastCalledWith(current);
    const base = await f.gateway.read("notes/plan.md");
    const type = { name: "note", path: "_types/note.md", revision: "sha256:test", document: "source" };
    for (const write of [
      () => f.gateway.create({ path: "new.md", title: "New", body: "viewer", properties: {} }),
      () => f.gateway.restore(base),
      () => f.gateway.update(base, { body: "viewer" }),
      () => f.gateway.updateDocument(base.path, "viewer", base.revision),
      () => f.gateway.updateProperties(base.path, { title: "viewer" }, base.revision),
      () => f.gateway.rename(base.path, "renamed.md", base.revision),
      () => f.gateway.delete(base.path, base.revision),
      () => f.gateway.createType("invalid type"),
      () => f.gateway.updateType(type, "invalid type"),
      () => f.gateway.uploadFile("attachments/viewer.txt", new Blob(["viewer"]))
    ]) await expect(write()).rejects.toMatchObject({ code: "forbidden", reason: "read_only", message: "You have view access, so changes can't be saved." });
    expect(f.client.ledger.getSnapshot()).toMatchObject({ pending: [], rejected: [] });
    expect((await f.gateway.read(base.path)).body).toBe(base.body);
    setRole("editor");
    const upgraded = f.gateway.sessionSnapshot();
    expect(editorPermissions(upgraded.status === "ready" ? upgraded.connection : null).canCreateNotes).toBe(true);
    await expect(f.gateway.create({ path: "after-upgrade.md", title: "Allowed", body: "authorized", properties: {} })).resolves.toMatchObject({ path: "after-upgrade.md" });
    stop();
  });

  it("applies native role changes live and keeps saves independent of Connect list refreshes", async () => {
    const f = await fixture({}, seedNotes);
    const base = await f.gateway.read("notes/plan.md");
    f.controls.setHandler("refreshCollectionList", () => { throw new Error("Connect unavailable"); });
    await expect(f.gateway.create({ path: "owner.md", title: "Owner", body: "allowed", properties: {} })).resolves.toMatchObject({ path: "owner.md" });
    const changed = vi.fn();
    const stop = f.gateway.onSessionChange(changed);
    const status = vi.spyOn(f.client, "status", "get").mockReturnValue({ ...f.client.status, incidents: [{ kind: "read_only" }] });
    f.replica.setOnline(false);
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ connection: expect.objectContaining({ role: "viewer" }) })));
    await expect(f.gateway.updateDocument(base.path, "downgraded", base.revision)).rejects.toMatchObject({ reason: "read_only" });
    expect((await f.gateway.read(base.path)).body).toBe(base.body);
    expect(f.client.ledger.getSnapshot()).toMatchObject({ pending: [], rejected: [] });
    status.mockReturnValue({ ...f.client.status, incidents: [], grant: { role: "editor", capabilities: ["collection.read", "records.edit"] } } as typeof f.client.status);
    f.replica.setOnline(true);
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ connection: expect.objectContaining({ role: "editor" }) })));
    stop();
    const upgraded = f.gateway.sessionSnapshot();
    expect(editorPermissions(upgraded.status === "ready" ? upgraded.connection : null).canEditNotes).toBe(true);
    expect(f.controls.observedActions().some((call) => call.action === "refreshCollectionList")).toBe(false);
  });

  it("refuses a membership downgrade before local signed policy catches up", async () => {
    const f = await fixture({}, seedNotes);
    const status = vi.spyOn(f.client, "status", "get").mockReturnValue({ ...f.client.status,
      grant: { role: "editor", capabilities: ["collection.read", "records.edit"] }
    } as typeof f.client.status);
    const snapshot = f.application.getSnapshot();
    f.controls.publishSnapshot({ ...snapshot, collections: snapshot.collections.map((entry) => ({ ...entry, role: "viewer" })) });
    expect(f.gateway.sessionSnapshot()).toMatchObject({ connection: { role: "viewer" } });
    await expect(f.gateway.create({ path: "early-downgrade.md", title: "Refused", body: "viewer", properties: {} }))
      .rejects.toMatchObject({ reason: "read_only" });
    expect(f.client.ledger.getSnapshot()).toMatchObject({ pending: [], rejected: [] });
    status.mockReturnValue({ ...f.client.status, incidents: [{ kind: "read_only" }], grant: { role: "viewer", capabilities: ["collection.read"] } } as typeof f.client.status);
    const notified = vi.fn();
    const stop = f.client.onStatus(notified);
    notified.mockClear();
    f.replica.setOnline(false);
    await vi.waitFor(() => expect(notified).toHaveBeenCalled());
    stop();
    // The Connect membership list is unchanged while this collection stays open.
    status.mockReturnValue({ ...f.client.status, incidents: [], grant: { role: "editor", capabilities: ["collection.read", "records.edit"] } } as typeof f.client.status);
    f.replica.setOnline(true);
    await vi.waitFor(() => expect(f.gateway.sessionSnapshot()).toMatchObject({ connection: { role: "editor" } }));
  });

  it("forwards authorize, choose and forget to the original application with the caller signal", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    await f.gateway.authorize("selected", { signal });
    await f.gateway.authorize("choose", { signal });
    await f.gateway.authorize({ collectionId: f.replica.collection }, { signal });
    await f.gateway.forgetConnection(f.replica.collection);
    expect(f.controls.observedActions().map((call) => [call.action, call.collectionId, call.signal === signal]))
      .toEqual(expect.arrayContaining([["reauthorize", undefined, true], ["chooseAnother", undefined, true],
        ["select", f.replica.collection, true], ["forget", f.replica.collection, false]]));
  });

  it("describes type schemas, versions and contract schemas from the native catalog", async () => {
    const f = await fixture({}, seedNotes);
    const describe = f.client.describe.bind(f.client);
    const map = (value: object): Map<string, unknown> => new Map(Object.entries(value).map(([key, item]) =>
      [key, item && typeof item === "object" && !Array.isArray(item) ? map(item) : item]));
    const schema = { type: "object", properties: { name: { type: "string" }, email: { type: "string" } } };
    vi.spyOn(f.client, "describe").mockImplementation(async (options) => {
      const base = await describe(options);
      if (!(typeof options === "object" && !(options instanceof AbortSignal) && options.definitions)) return base;
      return { ...base,
        types: [{ name: "person", path: "_types/person.md", version: 2, revision: `sha256:${"a".repeat(64)}`,
          implements: [{ contract: "mdbase.person", version: "2.0.0", fields: new Map([["name", "name"]]), digest: `sha256:${"b".repeat(64)}` }],
          definition: map({ kind: "mdbase.type", name: "person", version: 2, description: "People", extensions: { "x-app": { on: true } }, schema }), schema: map(schema) }],
        contracts: [{ id: "mdbase.person", version: "2.0.0", path: "_contracts/person.md", digest: `sha256:${"c".repeat(64)}`, contractType: "record",
          implementedBy: ["person"], schemas: new Map([["record_schema", map(schema)]]) }] } as Awaited<ReturnType<typeof describe>>;
    });
    const description = await f.gateway.describe();
    expect(description.typing).toBeUndefined();
    expect(description.types).toEqual([expect.objectContaining({ name: "person", version: 2, description: "People", schema, extensions: { "x-app": { on: true } } })]);
    expect(description.contracts[0]).toMatchObject({ id: "mdbase.person", schema,
      implementations: [{ typeName: "person", typePath: "_types/person.md", typeVersion: 2, digest: `sha256:${"b".repeat(64)}`, fields: { name: "name" } }] });
    expect(outdatedPersonStarter(description)).toMatchObject({ typeVersion: 2 });
  });

  it("pages Person contract records through the real SDK's bounded selection", async () => {
    const f = await fixture();
    const original = f.client.call.bind(f.client);
    const pages = [
      { version: 1, contractDigest: "sha256:test", page: { records: [{ id: "person-a", path: "people/a.md" }], cursor: "next-person-page", complete: true }, records: [{ id: "person-a", implementations: [{ typeName: "person", fields: new Map([["name", "Ada"]]), issues: [] }] }] },
      { version: 1, contractDigest: "sha256:test", page: { records: [{ id: "person-b", path: "people/b.md" }], complete: true }, records: [{ id: "person-b", implementations: [{ typeName: "person", fields: new Map([["name", "Bea"]]), issues: [] }] }] },
    ];
    const selections: Array<Map<number, unknown>> = [];
    vi.spyOn(f.client, "call").mockImplementation(((method: string, params: unknown, options: unknown) => {
      if (method !== "query_contract_v1") return original(method, params as never, options as never);
      selections.push(params as Map<number, unknown>);
      return Promise.resolve(pages[selections.length - 1]);
    }) as typeof f.client.call);
    // queryContract itself is NOT mocked: its SDK validation rejects pageSize
    // above 128 before call(), exactly the original Your person record failure.
    await expect(f.gateway.queryContract({ id: "mdbase.person", version: "2.0.0", type: "person" })).resolves.toEqual([
      { path: "people/a.md", values: { name: "Ada" } }, { path: "people/b.md", values: { name: "Bea" } },
    ]);
    expect(selections.map(p => [p.get(1), p.get(2), p.get(3), p.get(4)])).toEqual([
      ["mdbase.person", "2.0.0", 128, undefined], ["mdbase.person", "2.0.0", 128, "next-person-page"],
    ]);
  });

  it("falls back to names-only when the replica cannot describe definitions", async () => {
    const f = await fixture({}, seedNotes);
    const describe = f.client.describe.bind(f.client);
    vi.spyOn(f.client, "describe").mockImplementation(async (options) => {
      if (typeof options === "object" && !(options instanceof AbortSignal) && options.definitions)
        throw new MdbaseError({ code: "upgrade_required", recovery: "upgrade", message: "no definitions" });
      return describe(options);
    });
    const description = await f.gateway.describe();
    expect(description).toMatchObject({ collectionId: f.replica.collection, typing: "names_only" });
    expect(description.types).toEqual([{ name: "note", path: "_types/note.md", schema: {}, extensions: {} }]);
    expect(outdatedPersonStarter({ ...description, contracts: [{ contractType: "record", id: "mdbase.person", version: "2.0.0", digest: "", schema: {},
      implementations: [{ typeName: "person", typePath: "_types/person.md", typeVersion: 0, digest: "", fields: {} }] }] })).toBeUndefined();
  });

  it("indexes complete native pages and reports exact record changes from the SDK watch", async () => {
    const f = await fixture({}, seedNotes);
    const observation = f.gateway.observe();
    const changes: EditorCollectionChange[] = [];
    observation.subscribeChanges((change) => changes.push(change));
    expect(await observation.ready).toEqual({ ok: true });
    expect(observation.getSnapshot().records.map((record) => record.path).sort()).toEqual(["notes/ideas.md", "notes/plan.md"]);
    expect(observation.getSnapshot().records.every((record) => record.body === undefined)).toBe(true);

    const created = await f.gateway.create({ title: "Draft", body: "Draft body", path: "notes/draft.md", properties: { status: "open" } });
    expect(created).toMatchObject({ path: "notes/draft.md", frontmatter: { status: "open" } });
    await settled(observation, (snapshot) => snapshot.records.some((record) => record.path === "notes/draft.md"));
    expect(observation.getSnapshot().total).toBe(3);
    expect(changes).toContainEqual({ source: "native", kind: "record.created", path: "notes/draft.md", revision: created.revision });

    const renamed = await f.gateway.rename("notes/draft.md", "notes/final.md", created.revision);
    await settled(observation, (snapshot) => snapshot.records.some((record) => record.path === "notes/final.md")
      && !snapshot.records.some((record) => record.path === "notes/draft.md"));
    expect(changes).toContainEqual({ source: "native", kind: "record.renamed", from: "notes/draft.md", to: "notes/final.md", revision: renamed.revision });

    await f.gateway.delete("notes/final.md", renamed.revision);
    await settled(observation, (snapshot) => !snapshot.records.some((record) => record.path === "notes/final.md"));
    expect(observation.getSnapshot().total).toBe(2);
    expect(changes).toContainEqual({ source: "native", kind: "record.deleted", path: "notes/final.md" });

    expect(await observation.hydrate()).toEqual({ ok: true });
    expect(observation.getSnapshot().records.find((record) => record.path === "notes/plan.md")?.body).toBe("# Plan\n");
    observation.close();
    expect(observation.getSnapshot().state).toBe("closed");
  });

  it("keeps the complete collection count current when journal-folder notes arrive and leave", async () => {
    const f = await fixture({}, seedNotes);
    const index = new CollectionIndexController(f.gateway);
    try {
      await index.reload();
      expect(index.getSnapshot().total).toBe(2);
      const create = (path: string) => f.gateway.create({ path, title: "Journal entry", body: "Entry", properties: {} });
      const first = await create("journal/2026-10-17.md");
      await create("journal/2026-10-18.md");
      await vi.waitFor(() => expect(index.getSnapshot().notes).toHaveLength(4));
      expect(index.getSnapshot().total).toBe(4);

      await f.gateway.delete(first.path, first.revision);
      await vi.waitFor(() => expect(index.getSnapshot().notes).toHaveLength(3));
      expect(index.getSnapshot().total).toBe(3);
      await index.reload();
      expect(index.getSnapshot().total).toBe(3);
    } finally { index.reset(); }
  });

  it("hydrates native bodies into Linked from and removes backlinks after a saved edit", async () => {
    const f = await fixture({}, replica => {
      replica.seed({ path: "notes/alpha.md", types: ["note"], frontmatter: {}, body: "# Alpha note\n\n[[Beta note]]" });
      replica.seed({ path: "notes/beta.md", types: ["note"], frontmatter: {}, body: "# Beta note\n\n[[Alpha note]]" });
    });
    const index = new CollectionIndexController(f.gateway);
    try {
      await index.reload();
      expect(index.getSnapshot().contentComplete).toBe(false);
      await index.hydrate();
      expect(index.getSnapshot().contentComplete).toBe(true);
      expect(index.getSnapshot().notes.every(note => note.file?.links === undefined)).toBe(true);
      const linkedFrom = (path: string) => backlinksFor(path, index.getSnapshot().notes).map(note => note.path);
      expect(linkedFrom("notes/alpha.md")).toEqual(["notes/beta.md"]);
      expect(linkedFrom("notes/beta.md")).toEqual(["notes/alpha.md"]);

      const beta = await f.gateway.read("notes/beta.md");
      await f.gateway.update(beta, { body: "# Beta note\n\nNo outgoing link." });
      await vi.waitFor(() => expect(linkedFrom("notes/alpha.md")).toEqual([]));
      expect(linkedFrom("notes/beta.md")).toEqual(["notes/alpha.md"]);
    } finally { index.reset(); }
  });

  it("optimistic overlays show until settled and roll back exactly", async () => {
    const f = await fixture({}, seedNotes);
    const observation = f.gateway.observe();
    await observation.ready;
    const plan = observation.getSnapshot().records.find((record) => record.path === "notes/plan.md")!;
    const staged = observation.optimistic([], ["notes/plan.md"]);
    expect(observation.getSnapshot().records.some((record) => record.path === "notes/plan.md")).toBe(false);
    expect(observation.getSnapshot().total).toBe(1);
    staged.rollback();
    expect(observation.getSnapshot().total).toBe(2);
    expect(observation.getSnapshot().records).toContainEqual(plan);
    observation.close();
  });

  it("a retired connection stops reads, observation and recovery at the next await", async () => {
    const f = await fixture({}, seedNotes);
    f.current.mockReturnValue(false);
    const read = f.gateway.read("notes/plan.md");
    await expect(read).rejects.toSatisfy((error: unknown) => isMdbaseError(error, "cancelled"));
    expect(() => f.gateway.observe()).toThrow("no longer open");
    expect(f.gateway.sessionSnapshot().status).toBe("unselected");
  });

  it("creates a type create-only and saves edits only over the revision that was opened", async () => {
    const f = await fixture({}, seedNotes);
    const source = "---\nkind: mdbase.type\nname: task\n---\n";
    const created = await f.gateway.createType(source);
    expect(created).toMatchObject({ name: "task", path: "_types/task.md", document: source });
    expect(await f.gateway.readType("task")).toEqual(created);
    await expect(f.gateway.createType(source)).rejects.toSatisfy((error: unknown) => isMdbaseError(error, "conflict"));

    const edited = `${source}Tasks.\n`;
    const saved = await f.gateway.updateType(created, edited);
    expect(saved).toMatchObject({ name: "task", document: edited });
    expect(saved.revision).not.toBe(created.revision);
    // A save over the stale revision is refused, never overwritten.
    await expect(f.gateway.updateType(created, `${source}Stale.\n`)).rejects.toSatisfy((error: unknown) => isMdbaseError(error, "conflict"));
    expect((await f.client.resources.get("_types/task.md")).text).toBe(edited);
  });

  it("installs a reviewed type pack through the SDK plan as one confirmed guarded write", async () => {
    const f = await fixture({}, (replica) => replica.seedResource("_types/note.md", "---\nname: old\n---\n"));
    const live = `sha256:${"ab".repeat(32)}`;
    const digest = (n: string) => `sha256:${n.repeat(64)}`;
    const document = "---\nkind: mdbase.type\nname: note\n---\n";
    const provision = { manifest: { kind: "mdbase.type-pack", id: "dev.mdbase.notes", version: "1.0.0", resources: [] }, resources: [{ source: "note.md", document }], provides: [] } as unknown as Parameters<typeof f.gateway.assessTypePack>[0];
    const native = (adopted: boolean, apply: boolean) => {
      const row = new Map<string, unknown>([["source", "note.md"], ["target", "_types/note.md"], ["kind", "type"], ["mode", "managed"],
        ["action", adopted ? "update" : "conflict"], ["digest", digest("c")], ["current_digest", live]]);
      if (adopted) row.set("adopted_from_digest", live);
      const assessment = new Map<string, unknown>([["status", adopted ? "install" : "conflict"], ["applicable", adopted], ["definitions_manage", true],
        ["assessment_digest", digest(adopted ? "2" : "1")],
        ["desired", new Map<string, unknown>([["id", "dev.mdbase.notes"], ["version", "1.0.0"], ["digest", digest("d")], ["installed_by", "dev.mdbase.editor"], ["resources", []]])],
        ["resources", [row]], ["lock", new Map([["target", "mdbase.lock.yaml"], ["action", "create"], ["digest", digest("e")]])]]);
      return { version: 1, assessment, ...(apply ? { writes: [{ path: "_types/note.md", doc: document, mustNotExist: false }, { path: "mdbase.lock.yaml", doc: "lock\n", mustNotExist: true }] } : {}) };
    };
    const call = f.client.call.bind(f.client);
    const planned: Array<Map<number, unknown>> = [];
    vi.spyOn(f.client, "call").mockImplementation(((method: string, params: unknown, options: unknown) => {
      if (method !== "plan_type_pack_v1") return call(method, params as never, options as never);
      const p = params as Map<number, unknown>;
      planned.push(p);
      return Promise.resolve(native(p.has(3), p.has(7)));
    }) as typeof f.client.call);

    const conflict = await f.gateway.assessTypePack(provision);
    expect(conflict).toMatchObject({ status: "conflict", applicable: false, resources: [{ action: "conflict", currentDigest: live }], contractSetups: { choices: [], resources: [] } });
    const reviewed = await f.gateway.assessTypePack(provision, { "_types/note.md": live });
    expect(reviewed).toMatchObject({ applicable: true, resources: [{ action: "update", adoptedFromDigest: live }] });
    await expect(f.gateway.applyTypePack(provision, reviewed, { "_types/note.md": live })).resolves.toMatchObject({ receipt: { id: "dev.mdbase.notes", installedBy: "dev.mdbase.editor" } });
    expect(planned.map((p) => [p.get(2), p.has(3), p.has(7)])).toEqual([["dev.mdbase.editor", false, false], ["dev.mdbase.editor", true, false], ["dev.mdbase.editor", true, true]]);
    expect((await f.client.resources.get("mdbase.lock.yaml")).text).toBe("lock\n");
    expect((await f.client.resources.get("_types/note.md")).text).toBe(document);
  });

  it("lists and reads files by native digest and never uploads with an unknown file grant", async () => {
    const f = await fixture();
    await f.client.files.upload("attachments/a.txt", Uint8Array.from([104, 101, 108, 108, 111]));
    const upload = vi.spyOn(f.client.files, "upload");
    const files = await f.gateway.listFiles();
    const get = vi.spyOn(f.client.files, "get");
    const download = vi.spyOn(f.client.files, "download");
    const stream = vi.spyOn(f.client.files, "downloadStream");
    expect(files).toEqual([expect.objectContaining({ path: "attachments/a.txt", size: 5, revision: expect.stringMatching(/^sha256:/), confirmedSeq: expect.any(Number) })]);
    expect(files[0]!.contentDigest).toBe(files[0]!.revision);
    expect(await (await f.gateway.readFile(files[0]!)).text()).toBe("hello");
    expect(stream).toHaveBeenCalledWith(files[0]!.fileId, { revision: files[0]!.revision, signal: expect.any(AbortSignal) });
    // A well-formed but stale digest exercises the SDK's pinned revision check,
    // rather than failing its revision-token parser before the request opens.
    await expect(f.gateway.readFile({ ...files[0]!, revision: `sha256:${"0".repeat(64)}` })).rejects.toThrow("changed");
    expect(get).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    vi.spyOn(f.client.files, "grant", "get").mockReturnValue(null);
    const snapshot = f.gateway.sessionSnapshot();
    expect(editorPermissions(snapshot.status === "ready" ? snapshot.connection : null).canAttachFiles).toBe(false);
    await expect(f.gateway.uploadFile("attachments/b.txt", new Blob(["x"]))).rejects.toThrow("not available");
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads through the original file grant and returns only confirmed original-file readback", async () => {
    const f = await fixture({ fileFolders: ["attachments"] });
    const upload = vi.spyOn(f.client.files, "upload");
    const progress = vi.fn();
    const transferId = crypto.randomUUID();
    // A view must upload only its bytes, not the surrounding backing buffer.
    const source = new Uint8Array([0, 104, 105, 0]).subarray(1, 3);
    const file = await f.gateway.uploadFile("attachments/hi.txt", source, { transferId, onProgress: progress });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("attachments/hi.txt", source, expect.objectContaining({ transferId, signal: expect.any(AbortSignal) }));
    expect(file).toMatchObject({ path: "attachments/hi.txt", size: 2 });
    expect(await (await f.gateway.readFile(file)).text()).toBe("hi");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "uploading", transferredBytes: 2, totalBytes: 2 }));

    const get = f.client.files.get.bind(f.client.files);
    const readback = vi.spyOn(f.client.files, "get").mockImplementationOnce(async (ref, signal) => {
      const view = await get(ref, signal);
      return { ...view, confirmedSeq: view.confirmedSeq + 1 };
    });
    const changed = await f.gateway.uploadFile("attachments/changed.txt", new Blob(["changed"])).catch((error: unknown) => error);
    const secondWrite = await upload.mock.results[1]!.value;
    expect(changed).toSatisfy((error: unknown) => isMdbaseError(error, "outcome_unknown") && error.mutationId === secondWrite.mutationId);

    readback.mockImplementationOnce(async (ref, signal) => {
      const view = await get(ref, signal);
      f.current.mockReturnValue(false);
      return view;
    });
    const retired = await f.gateway.uploadFile("attachments/later.txt", new Blob(["later"])).catch((error: unknown) => error);
    const thirdWrite = await upload.mock.results[2]!.value;
    expect(retired).toSatisfy((error: unknown) => isMdbaseError(error, "cancelled") && error.mutationId === thirdWrite.mutationId);
    expect(upload).toHaveBeenCalledTimes(3);
    // Retirement did not replay the upload; the SDK still owns its exact ID.
    expect((await f.client.awaitReceipt(thirdWrite.mutationId)).mutation).toBe(thirdWrite.mutationId);
  });

  it("maps native preflight rewrites and broken links", async () => {
    const f = await fixture({}, (replica) => {
      replica.seed({ path: "notes/target.md", body: "Target\n" });
      replica.seed({ path: "notes/source.md", body: "See [[target]]\n" });
    });
    const target = await f.gateway.read("notes/target.md");
    const rename = await f.gateway.preflightRename("notes/target.md", "notes/moved.md", target.revision);
    expect(rename.affectedPaths).toEqual(["notes/source.md"]);
    const removal = await f.gateway.preflightDelete("notes/target.md", target.revision);
    expect(removal.brokenLinkPaths).toEqual(["notes/source.md"]);
  });
});
