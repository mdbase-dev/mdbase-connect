import { isMdbaseError } from "@mdbase-dev/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorPermissions } from "./gateway";
import type { EditorCollectionChange, NoteObservationSnapshot } from "./model";
import { NativeEditorGateway } from "./native-gateway";
import { outdatedPersonStarter } from "./person-setup";
import { closeNativeFixtures, readyFixture } from "./test/native-fixture";

const gateways: NativeEditorGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.dispose();
  closeNativeFixtures();
});

async function fixture(...args: Parameters<typeof readyFixture>) {
  const f = await readyFixture(...args);
  const gateway = new NativeEditorGateway(f.application, f.connection);
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
  it("reports the original selected scope and maps only granted record capabilities", async () => {
    const f = await fixture();
    const snapshot = f.gateway.sessionSnapshot();
    expect(snapshot).toMatchObject({ status: "ready", connection: { collectionId: f.replica.collection, displayName: "Notes" } });
    const permissions = editorPermissions(snapshot.status === "ready" ? snapshot.connection : null);
    expect(permissions).toMatchObject({ canCreateNotes: true, canEditNotes: true, canRenameNotes: true, canDeleteNotes: true });
    // definitions.manage and files.write never widen into type install/manage or uploads.
    expect(permissions).toMatchObject({ canManageTypes: false, canInstallTypes: false, canAttachFiles: false });
    expect(f.gateway.selectConnection(f.replica.collection).collectionId).toBe(f.replica.collection);
    expect(() => f.gateway.selectConnection("another-collection")).toThrow("not ready");
    expect(await f.gateway.checkDirectAccess()).toBeNull();
  });

  it("a read-only grant exposes no write operations", async () => {
    const f = await fixture({ capabilities: ["collection.read"], role: "viewer" });
    const snapshot = f.gateway.sessionSnapshot();
    expect(editorPermissions(snapshot.status === "ready" ? snapshot.connection : null)).toMatchObject({
      canCreateNotes: false, canEditNotes: false, canRenameNotes: false, canDeleteNotes: false
    });
  });

  it("forwards authorize, choose and forget to the original application with the caller signal", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    await f.gateway.authorize("selected", { signal });
    await f.gateway.authorize("choose", { signal });
    await f.gateway.authorize({ collectionId: f.replica.collection }, { signal });
    await f.gateway.forgetConnection(f.replica.collection);
    expect(f.controls.observedActions().map((call) => [call.action, call.collectionId, call.signal === signal]))
      .toEqual(expect.arrayContaining([["authorize", undefined, true], ["clearSelection", undefined, true],
        ["select", f.replica.collection, true], ["forget", f.replica.collection, false]]));
  });

  it("describes native types and contracts honestly as names-only", async () => {
    const f = await fixture({}, seedNotes);
    const description = await f.gateway.describe();
    expect(description).toMatchObject({ collectionId: f.replica.collection, displayName: "Notes", typing: "names_only" });
    expect(description.types).toEqual([{ name: "note", path: "_types/note.md", schema: {}, extensions: {} }]);
    expect(description.operations).toEqual(expect.arrayContaining(["read", "query", "create", "update", "rename", "delete"]));
    expect(description.operations).not.toContain("create_type");
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
    expect(changes).toContainEqual({ source: "native", kind: "record.created", path: "notes/draft.md", revision: created.revision });

    const renamed = await f.gateway.rename("notes/draft.md", "notes/final.md", created.revision);
    await settled(observation, (snapshot) => snapshot.records.some((record) => record.path === "notes/final.md")
      && !snapshot.records.some((record) => record.path === "notes/draft.md"));
    expect(changes).toContainEqual({ source: "native", kind: "record.renamed", from: "notes/draft.md", to: "notes/final.md", revision: renamed.revision });

    await f.gateway.delete("notes/final.md", renamed.revision);
    await settled(observation, (snapshot) => !snapshot.records.some((record) => record.path === "notes/final.md"));
    expect(changes).toContainEqual({ source: "native", kind: "record.deleted", path: "notes/final.md" });

    expect(await observation.hydrate()).toEqual({ ok: true });
    expect(observation.getSnapshot().records.find((record) => record.path === "notes/plan.md")?.body).toBe("# Plan\n");
    observation.close();
    expect(observation.getSnapshot().state).toBe("closed");
  });

  it("optimistic overlays show until settled and roll back exactly", async () => {
    const f = await fixture({}, seedNotes);
    const observation = f.gateway.observe();
    await observation.ready;
    const plan = observation.getSnapshot().records.find((record) => record.path === "notes/plan.md")!;
    const staged = observation.optimistic([], ["notes/plan.md"]);
    expect(observation.getSnapshot().records.some((record) => record.path === "notes/plan.md")).toBe(false);
    staged.rollback();
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

  it("reads type sources but refuses type creation and setup without writing", async () => {
    const f = await fixture({}, (replica) => {
      replica.seedResource("_types/note.md", "---\nname: note\n---\n");
      seedNotes(replica);
    });
    const put = vi.spyOn(f.client.resources, "put");
    expect(await f.gateway.readType("note")).toMatchObject({ name: "note", path: "_types/note.md", document: "---\nname: note\n---\n" });
    await expect(f.gateway.createType()).rejects.toThrow("not available");
    await expect(f.gateway.assessTypePack()).rejects.toThrow("setup");
    expect(put).not.toHaveBeenCalled();
  });

  it("lists and reads files by native digest and never uploads without a file grant", async () => {
    const f = await fixture();
    await f.client.files.upload("attachments/a.txt", Uint8Array.from([104, 101, 108, 108, 111]));
    const upload = vi.spyOn(f.client.files, "upload");
    const files = await f.gateway.listFiles();
    expect(files).toEqual([expect.objectContaining({ path: "attachments/a.txt", size: 5, revision: expect.stringMatching(/^sha256:/) })]);
    expect(files[0]!.contentDigest).toBe(files[0]!.revision);
    expect(await (await f.gateway.readFile(files[0]!)).text()).toBe("hello");
    await expect(f.gateway.readFile({ ...files[0]!, revision: "sha256:00" })).rejects.toThrow("changed");
    await expect(f.gateway.uploadFile("attachments/b.txt", new Blob(["x"]))).rejects.toThrow("not available");
    expect(upload).not.toHaveBeenCalled();
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
