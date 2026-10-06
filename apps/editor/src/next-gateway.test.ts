import { MdbaseConnectError, type CollectionChange } from "@mdbase-dev/connect";
import { connect, mdbaseError, uuidv7, wire, type CborValue, type ConflictEntry, type Connector, type ErrorCode, type FramePort, type Hold } from "@mdbase-dev/sdk";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionIndexController } from "./collection-index-controller";
import { gatewayError } from "./gateway";
import type { CollectionSessionSnapshot, NoteMutationProgress, NoteSummary, SyncAttention } from "./model";
import { nextDemoSource } from "./next-demo";
import { nextErrorMessage, toConnectError, WAITING_FOR_DEVICE } from "./next-errors";
import { NextCollectionGateway } from "./next-gateway";
import { NOTE_WINDOW } from "./next-observation";
import { updateMutationActivity } from "./note-mutation-presentation";
import type { NoteSession } from "./note-session";

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

describe("rename and delete progress", () => {
  const states = (events: NoteMutationProgress[]) => events.map((event) => [event.state, event.cancellable]);

  it("follows the receipt: cancellable until captured, then submitted, then completed", async () => {
    const { gateway, replica } = await openGateway(1);
    const opened = await gateway.read("Projects/Replica port.md");
    const events: NoteMutationProgress[] = [];
    const renamed = await gateway.rename(opened.path, "Archive/Replica port.md", opened.revision, true, { onProgress: (event) => events.push(event) });
    expect(renamed.path).toBe("Archive/Replica port.md");
    expect(states(events)).toEqual([["applying", true], ["submitted", false]]);

    replica.confirmAll();
    await vi.waitFor(() => expect(states(events).at(-1)).toEqual(["completed", false]));

    const doomed = await gateway.read("Projects/Search.md");
    const deletes: NoteMutationProgress[] = [];
    await gateway.delete(doomed.path, doomed.revision, { onProgress: (event) => deletes.push(event) });
    replica.confirmAll();
    await vi.waitFor(() => expect(states(deletes)).toEqual([["applying", true], ["submitted", false], ["completed", false]]));
    expect(replica.allRecords.some((record) => record.path === "Projects/Search.md")).toBe(false);
  });

  it("surfaces a rejection instead of reporting it submitted", async () => {
    const { gateway } = await openGateway(1);
    const opened = await gateway.read("Projects/Replica port.md");
    const events: NoteMutationProgress[] = [];
    await expect(gateway.rename(opened.path, "Projects/Search.md", opened.revision, true, { onProgress: (event) => events.push(event) }))
      .rejects.toMatchObject({ problem: { code: "path_occupied" } });
    expect(states(events)).toEqual([["applying", true]]);
  });

  it("cancels before capture, and nothing changes", async () => {
    const { gateway, replica } = await openGateway(1);
    const opened = await gateway.read("Projects/Replica port.md");
    const controller = new AbortController();
    controller.abort();
    await expect(gateway.rename(opened.path, "Elsewhere.md", opened.revision, true, { signal: controller.signal }))
      .rejects.toMatchObject({ problem: { code: "operation_cancelled" } });
    await expect(gateway.delete(opened.path, opened.revision, { signal: controller.signal }))
      .rejects.toMatchObject({ problem: { code: "operation_cancelled" } });
    expect(replica.allRecords.some((record) => record.path === "Projects/Replica port.md")).toBe(true);
  });

  it("tells the user a captured change can't be cancelled", () => {
    const session = { activityDetail: undefined, mutationCancellable: true } as unknown as NoteSession;
    updateMutationActivity(session, { operation: "rename", state: "submitted", cancellable: false, resumed: false, completedUnits: 1, elapsedMs: 3 }, () => undefined);
    expect(session.activityDetail).toBe("Moved; can’t be cancelled now");
    expect(session.mutationCancellable).toBe(false);
  });
});

describe("describe.changeCursor", () => {
  it("is the replica's view version, not a placeholder", async () => {
    const { gateway } = await openGateway(2);
    const before = (await gateway.describe()).changeCursor;
    expect(before).toBeGreaterThan(0);
    const opened = await gateway.read("Welcome.md");
    await gateway.updateProperties(opened.path, { status: "read" }, opened.revision);
    expect((await gateway.describe()).changeCursor).toBeGreaterThan(before);
  });
});

/**
 * MemoryReplica has no holds or conflicts. This proxy answers the §8 methods
 * itself and pushes `holds`/`conflicts`, forwarding everything else.
 */
function attentionConnector(replica: MemoryReplica, state: { holds: Hold[]; conflicts: ConflictEntry[]; resolved: Array<[string, string]> }): Connector & { push(): void } {
  const ports = new Set<FramePort>();
  const pushTo = (port: FramePort) => {
    port.onframe?.(wire.clientFrame.enc({ kind: "push", type: "holds", payload: state.holds.map((hold) => wire.hold.enc(hold)) }));
    port.onframe?.(wire.clientFrame.enc({ kind: "push", type: "conflicts", payload: state.conflicts.map((entry) => wire.conflictEntry.enc(entry)) }));
  };
  return {
    description: "attention",
    push: () => { for (const port of ports) pushTo(port); },
    open: async (hello) => {
      const inner = await replica.connector().open(hello);
      const outer: FramePort = {
        onframe: null,
        onclose: null,
        close: () => inner.port.close(),
        send: (raw: CborValue) => {
          const frame = wire.clientFrame.dec(raw);
          if (frame.kind !== "request") return inner.port.send(raw);
          const reply = (result: CborValue) => queueMicrotask(() => outer.onframe?.(wire.clientFrame.enc({ kind: "response", id: frame.id, result })));
          const params = frame.params as Map<number, CborValue>;
          switch (frame.method) {
            case "list_holds": return reply(state.holds.map((hold) => wire.hold.enc(hold)));
            case "list_conflicts": return reply(state.conflicts.map((entry) => wire.conflictEntry.enc(entry)));
            case "subscribe_holds":
            case "subscribe_conflicts": return reply(null);
            case "resolve_hold": {
              const id = wire.holdRef.dec(new Map([[0, params.get(0)!], [1, 0]])).id;
              state.resolved.push([id, wire.holdResolution.dec(params.get(1)!)]);
              state.holds = state.holds.filter((hold) => hold.id !== id);
              reply(wire.receipt.enc({ mutation: uuidv7(), state: "confirmed", seq: 1 }));
              return queueMicrotask(() => pushTo(outer));
            }
            case "submit": {
              const submitted = wire.submitParams.dec(frame.params);
              const dismissed = submitted.ops.flatMap((op) => op.kind === "conflict_dismiss" ? [op.mutation] : []);
              if (dismissed.length) {
                state.conflicts = state.conflicts.filter((entry) => !dismissed.includes(entry.mutation));
                queueMicrotask(() => pushTo(outer));
              }
              return inner.port.send(raw);
            }
            default: return inner.port.send(raw);
          }
        }
      };
      inner.port.onframe = (frame) => outer.onframe?.(frame);
      inner.port.onclose = (error) => { ports.delete(outer); outer.onclose?.(error); };
      ports.add(outer);
      return { port: outer, helloResponse: inner.helloResponse };
    }
  };
}

describe("holds and conflicts", () => {
  it("lists holds and conflicts and resolves each one", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const task = replica.seed({ path: "Task.md", frontmatter: { status: "done" }, body: "kept body\n" });
    const state = {
      holds: [{ id: task.id, path: "Task.md", reason: "conflict" as const, since: 1, mine: "mine", theirs: "theirs", saves: 2 }],
      conflicts: [
        { mutation: uuidv7(), seq: 3, conflict: { kind: "field" as const, id: task.id, field: "status", kept: { form: "value" as const, value: "done" }, lost: { form: "value" as const, value: "blocked" } } },
        { mutation: uuidv7(), seq: 4, conflict: { kind: "body" as const, id: task.id, kept: { form: "text" as const, text: "kept body\n" }, lost: { form: "text" as const, text: "lost body\n" } } }
      ],
      resolved: [] as Array<[string, string]>
    };
    const connector = attentionConnector(replica, state);
    const gateway = new NextCollectionGateway({ open: async () => ({ connector }) }, app);
    cleanups.push(() => gateway.close());
    expect((await gateway.startSession()).status).toBe("ready");

    let attention: SyncAttention = { holds: [], conflicts: [] };
    const stop = gateway.onSyncAttention((next) => { attention = next; });
    cleanups.push(stop);
    await vi.waitFor(() => {
      expect(attention.holds).toEqual([{ id: task.id, path: "Task.md", reason: "conflict", since: 1, saves: 2, hasTheirs: true }]);
      expect(attention.conflicts).toHaveLength(2);
    });
    const [field, body] = attention.conflicts;
    expect(field).toMatchObject({ path: "Task.md", kind: "field", field: "status", kept: "\"done\"", lost: "\"blocked\"", restorable: true });
    expect(body).toMatchObject({ kind: "body", kept: "kept body\n", lost: "lost body\n", restorable: true });

    await gateway.resolveHold(task.id, "keep_both");
    expect(state.resolved).toEqual([[task.id, "keep_both"]]);
    await vi.waitFor(() => expect(attention.holds).toEqual([]));

    await gateway.resolveConflict(field!.key, "lost");
    await vi.waitFor(() => expect(attention.conflicts.map((conflict) => conflict.kind)).toEqual(["body"]));
    expect(replica.allRecords[0]!.frontmatter.get("status")).toBe("blocked");

    await gateway.resolveConflict(body!.key, "kept");
    await vi.waitFor(() => expect(attention.conflicts).toEqual([]));
    expect(replica.allRecords[0]!.body).toBe("kept body\n");
  });

  it("reports nothing to review in Connect mode", async () => {
    const { ConnectCollectionGateway } = await import("./gateway");
    const seen: SyncAttention[] = [];
    ConnectCollectionGateway.prototype.onSyncAttention.call(undefined as never, (attention) => seen.push(attention))();
    expect(seen).toEqual([{ holds: [], conflicts: [] }]);
  });
});
