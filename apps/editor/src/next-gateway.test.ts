import { MdbaseConnectError, type CollectionChange } from "@mdbase-dev/connect";
import { connect, mdbaseError, type Connector, type ErrorCode } from "@mdbase-dev/sdk";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionIndexController } from "./collection-index-controller";
import { gatewayError } from "./gateway";
import type { CollectionSessionSnapshot, NoteSummary } from "./model";
import { nextDemoSource } from "./next-demo";
import { nextErrorMessage, toConnectError, WAITING_FOR_DEVICE } from "./next-errors";
import { NextCollectionGateway } from "./next-gateway";
import { NOTE_WINDOW } from "./next-observation";

const app = { name: "editor-test", version: "0" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A gateway on a seeded MemoryReplica: 3 hand-written notes plus `generated`. */
async function openGateway(generated = 250) {
  const source = nextDemoSource({ confirmDelayMs: null, generated });
  const gateway = new NextCollectionGateway(source, app);
  const snapshot = await gateway.startSession();
  expect(snapshot.status).toBe("ready");
  const index = new CollectionIndexController(gateway, gatewayError);
  cleanups.push(() => { index.reset(); gateway.close(); });
  return { gateway, replica: source.replica, index };
}

function note(index: CollectionIndexController, path: string): NoteSummary | undefined {
  return index.getSnapshot().notes.find((candidate) => candidate.path === path);
}

describe("NextCollectionGateway on MemoryReplica", () => {
  it("lists notes in a live window without bodies and widens it on demand", async () => {
    const { index, gateway } = await openGateway(250);
    const get = vi.spyOn(Object.getPrototypeOf(gateway), "read");

    await index.reload();
    const first = index.getSnapshot();
    expect(first.notes).toHaveLength(NOTE_WINDOW);
    expect(first.notes.every((row) => row.body === undefined)).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.structureComplete).toBe(true);

    await index.loadMore();
    const widened = index.getSnapshot();
    expect(widened.notes).toHaveLength(253);
    expect(widened.notes.every((row) => row.body === undefined)).toBe(true);
    expect(widened.hasMore).toBe(false);
    expect(widened.total).toBe(253);

    // Search never hydrates every body on this backend.
    await index.hydrate();
    expect(index.getSnapshot().contentError).toMatch(/isn’t available with the mdbase-next backend/);
    expect(index.getSnapshot().notes.every((row) => row.body === undefined)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("reads a note's body when it opens", async () => {
    const { gateway, index } = await openGateway(5);
    await index.reload();
    expect(note(index, "Welcome.md")?.body).toBeUndefined();

    const opened = await gateway.read("Welcome.md");
    expect(opened.body).toContain("in-memory replica");
    expect(opened.frontmatter).toMatchObject({ title: "Welcome to mdbase-next", tags: ["demo"] });
    expect(opened.revision).toMatch(/^sha256:/);
  });

  it("returns optimistic edits immediately and shows them pending until confirmed", async () => {
    const { gateway, replica, index } = await openGateway(5);
    await index.reload();
    const opened = await gateway.read("Welcome.md");

    const saved = await gateway.update(opened, { patch: { title: "Renamed welcome" }, body: `${opened.body}One more line.\n` });
    expect(saved.frontmatter.title).toBe("Renamed welcome");
    expect(saved.body).toMatch(/One more line\.\n$/);
    expect(saved.revision).not.toBe(opened.revision);

    await vi.waitFor(() => {
      expect(note(index, "Welcome.md")).toMatchObject({ syncState: "pending", frontmatter: { title: "Renamed welcome" } });
      expect(index.getSnapshot().sync?.pending).toBe(1);
    });

    replica.confirmAll();
    await vi.waitFor(() => {
      expect(note(index, "Welcome.md")?.syncState).toBe("confirmed");
      expect(index.getSnapshot().sync).toMatchObject({ pending: 0 });
    });
    expect(replica.allRecords.find((record) => record.path === "Welcome.md")?.body).toMatch(/One more line\.\n$/);

    // The next edit builds on the optimistic result without re-reading.
    const again = await gateway.updateProperties(saved.path, { tags: null }, saved.revision);
    expect(again.frontmatter).not.toHaveProperty("tags");
  });

  it("applies another client's edits from live pushes, without polling", async () => {
    const { gateway, replica, index } = await openGateway(5);
    await index.reload();
    const changes: CollectionChange[] = [];
    index.subscribeChanges((change) => changes.push(change));
    const editorView = await gateway.read("Projects/Search.md");

    const other = await connect({ app: { name: "other", version: "0" }, connector: replica.connector() });
    cleanups.push(() => other.close());
    const seen = await other.get({ path: "Projects/Search.md" }, { body: true });
    await other.update(seen, { patch: { status: "active" } });
    await other.create({ path: "From elsewhere.md", frontmatter: { title: "From elsewhere" }, body: "Hi\n" });

    await vi.waitFor(() => {
      expect(note(index, "Projects/Search.md")?.frontmatter.status).toBe("active");
      expect(note(index, "From elsewhere.md")?.body).toBeUndefined();
      expect(note(index, "From elsewhere.md")?.frontmatter.title).toBe("From elsewhere");
    });
    // Open notes learn the new revision from the change feed (ID and path only).
    await vi.waitFor(() => expect(changes).toContainEqual(expect.objectContaining({ kind: "record.updated", path: "Projects/Search.md" })));
    const fresh = await gateway.read("Projects/Search.md");
    expect(fresh.revision).not.toBe(editorView.revision);

    // A rename elsewhere arrives as one rename, not a delete.
    const moved = await other.get({ path: "From elsewhere.md" });
    await other.rename(moved, "Archive/From elsewhere.md");
    await vi.waitFor(() => expect(changes).toContainEqual(expect.objectContaining({
      kind: "record.renamed", from: "From elsewhere.md", to: "Archive/From elsewhere.md"
    })));
    expect(changes.some((change) => change.kind === "record.deleted")).toBe(false);
  });

  it("uploads with progress, lists and downloads files", async () => {
    const { gateway } = await openGateway(1);
    const bytes = new Uint8Array(1_500_000).map((_, index) => index % 251);
    const progress: number[] = [];
    const uploaded = await gateway.uploadFile("Attachments/diagram.png", bytes, {
      onProgress: (event) => progress.push(event.transferredBytes)
    });
    expect(uploaded).toMatchObject({ path: "Attachments/diagram.png", size: bytes.length, mediaClass: "image" });
    expect(progress.at(-1)).toBe(bytes.length);
    expect(progress.length).toBeGreaterThan(1);

    const listed = await gateway.listFiles();
    expect(listed.map((file) => file.path)).toEqual(["Attachments/diagram.png"]);

    const downloads: number[] = [];
    const blob = await gateway.readFile(listed[0]!, { onProgress: (event) => downloads.push(event.transferredBytes) });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(downloads.at(-1)).toBe(bytes.length);
  });
});

describe("mdbase-next error mapping", () => {
  const cases: Array<[ErrorCode, string | undefined, string]> = [
    ["invalid_request", undefined, "invalid_request"],
    ["invalid_record", undefined, "operation_invalid"],
    ["not_found", undefined, "file_not_found"],
    ["conflict", "revision", "concurrent_modification"],
    ["conflict", "path_taken", "path_occupied"],
    ["unauthenticated", undefined, "not_authorized"],
    ["forbidden", undefined, "not_authorized"],
    ["collection_invalid", undefined, "collection_invalid"],
    ["unavailable", undefined, "temporarily_unavailable"],
    ["unavailable", "no_device_online", "connector_offline"],
    ["rate_limited", undefined, "rate_limited"],
    ["quota_exceeded", undefined, "operation_failed"],
    ["too_large", undefined, "operation_invalid"],
    ["upgrade_required", undefined, "connector_upgrade_required"],
    ["outcome_unknown", undefined, "operation_outcome_unknown"],
    ["cancelled", undefined, "operation_cancelled"],
    ["internal", undefined, "operation_failed"]
  ];

  it.each(cases)("maps %s/%s to the Connect problem %s with app text", (code, reason, connectCode) => {
    const error = mdbaseError(code, "developer message", reason ?? {});
    const mapped = toConnectError(error, "0190a8c4-0000-7000-8000-000000000000");
    expect(mapped).toBeInstanceOf(MdbaseConnectError);
    expect(mapped.problem.code).toBe(connectCode);
    expect(mapped.cause).toBe(error);
    expect(gatewayError(mapped)).toBe(nextErrorMessage(error));
    expect(gatewayError(error)).not.toContain("developer message");
  });

  it("keeps the mutation for outcome-unknown recovery", () => {
    const mapped = toConnectError(mdbaseError("outcome_unknown", "lost"), "0190a8c4-0000-7000-8000-000000000001");
    expect(mapped.problem).toMatchObject({ operation_outcome: "unknown", details: { request_id: "0190a8c4-0000-7000-8000-000000000001" } });
  });

  it("surfaces replica rejections through the existing error UI", async () => {
    const { gateway } = await openGateway(1);
    const taken = gateway.create({ title: "Welcome", body: "", path: "Welcome.md", properties: {} });
    await expect(taken).rejects.toMatchObject({ problem: { code: "path_occupied" } });
    await expect(taken.catch(gatewayError)).resolves.toBe("A note or file already exists at that path.");
    await expect(gateway.read("Missing.md")).rejects.toMatchObject({ problem: { code: "file_not_found" } });
    await expect(gateway.readType("task")).rejects.toMatchObject({ problem: { code: "unsupported_operation" } });
  });

  it("waits for one of the user's devices instead of failing", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    replica.seed({ path: "Note.md", body: "x" });
    let online = false;
    const connector: Connector = {
      description: "test",
      open: (hello) => online
        ? replica.connector().open(hello)
        : Promise.reject(mdbaseError("unavailable", "no device", "no_device_online"))
    };
    const gateway = new NextCollectionGateway({ open: async () => ({ connector }) }, app);
    cleanups.push(() => gateway.close());
    const seen: CollectionSessionSnapshot[] = [];
    gateway.onSessionChange((snapshot) => seen.push(snapshot));

    const first = await gateway.startSession();
    expect(first).toMatchObject({ status: "start_failed", problem: { message: WAITING_FOR_DEVICE } });

    online = true;
    await vi.waitFor(() => expect(seen.at(-1)?.status).toBe("ready"), { timeout: 5_000 });
    expect((await gateway.read("Note.md")).body).toBe("x");
  });
});
