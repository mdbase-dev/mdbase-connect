import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectProblem, JsonObject } from "@mdbase-dev/connect-protocol";
import { connectProblem } from "./errors.js";
import type { CollectionChange, RecordDocument, UpdateInput, WatchStatus } from "./operation-types.js";
import { connectFailure, connectSuccess } from "./outcomes.js";
import { MdbaseRecords } from "./records.js";

function record(path: string, body: string, revision: string, frontmatter: JsonObject = {}): RecordDocument {
  return { path, revision, body, frontmatter, effectiveFrontmatter: frontmatter, types: [], file: { path } };
}

/** An authority with one record store, revision checks and a lossy network. */
function fakeConnection() {
  const records = new Map<string, RecordDocument>([["note.md", record("note.md", "Original", "r1")]]);
  let revision = 1;
  const pending = new Map<string, { recover: () => Promise<unknown> }>();
  let loseNext = false;
  const read = vi.fn(async ({ path }: { path: string }, _options?: unknown) => {
    const current = records.get(path);
    return current
      ? connectSuccess(structuredClone(current))
      : connectFailure(connectProblem("file_not_found", "Missing"));
  });
  const update = vi.fn(async (input: UpdateInput, _options?: unknown) => {
    const current = records.get(input.path);
    if (!current) return connectFailure(connectProblem("file_not_found", "Missing"));
    if (current.revision !== input.ifRevision) {
      return connectFailure(connectProblem("concurrent_modification", "Revision changed", { operationOutcome: "rejected" }));
    }
    const next = record(input.path, "body" in input && input.body !== undefined ? input.body : current.body ?? "",
      `r${String(++revision)}`, { ...current.frontmatter, ...("patch" in input ? input.patch : {}) });
    records.set(input.path, next);
    if (loseNext) {
      loseNext = false;
      pending.set("lost", { recover: async () => { pending.delete("lost"); return connectSuccess(structuredClone(next)); } });
      return connectFailure(connectProblem("operation_outcome_unknown", "Response lost", {
        operationOutcome: "unknown", details: { request_id: "lost" }
      }));
    }
    return connectSuccess(structuredClone(next));
  });
  const listeners: ((change: CollectionChange) => void)[] = [];
  const statuses: ((status: WatchStatus) => void)[] = [];
  return {
    connection: {
      read, update,
      pendingMutation: (id: string) => pending.get(id) ?? null
    },
    watch: {
      subscribe: (listener: (change: CollectionChange) => void, onStatus?: (status: WatchStatus) => void) => {
        listeners.push(listener);
        if (onStatus) statuses.push(onStatus);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      }
    },
    emit: (type: string, payload: JsonObject) => {
      for (const listener of [...listeners]) listener({ cursor: 1, type, occurredAt: "", payload });
    },
    reset: () => {
      for (const status of statuses) {
        status({ state: "reset_required", cursor: 1, problem: connectProblem("change_cursor_reset", "Gap") as ConnectProblem<"change_cursor_reset"> });
      }
    },
    elsewhere(path: string, body: string) {
      const next = record(path, body, `r${String(++revision)}`);
      records.set(path, next);
      return next;
    },
    move(from: string, to: string) {
      const current = records.get(from)!;
      records.delete(from);
      const next = { ...current, path: to, revision: `r${String(++revision)}` };
      records.set(to, next);
      return next;
    },
    remove(path: string) { records.delete(path); },
    stored: (path: string) => records.get(path),
    loseNextResponse() { loseNext = true; }
  };
}

function setup() {
  const fake = fakeConnection();
  return { ...fake, records: new MdbaseRecords(fake.connection as never) };
}

async function open(records: MdbaseRecords, path = "note.md", options = {}) {
  const opened = await records.open(path, options);
  if (!opened.ok) throw new Error(opened.problem.message);
  return opened.value;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("connection.records", () => {
  it("opens a record and saves only the changed parts with a revision check", async () => {
    const { records, connection, stored } = setup();
    const { session } = await open(records);
    session.patchFrontmatter({ title: "Mine" });
    session.setBody("Body");
    await expect(session.flush()).resolves.toMatchObject({ ok: true, value: { revision: "r2", body: "Body" } });
    expect(connection.update).toHaveBeenCalledExactlyOnceWith(
      { path: "note.md", ifRevision: "r1", patch: { title: "Mine" }, body: "Body" }, undefined);
    expect(stored("note.md")).toMatchObject({ body: "Body", frontmatter: { title: "Mine" } });
  });

  it("autosaves after one second by default", async () => {
    const { records, stored } = setup();
    const { session } = await open(records);
    session.setBody("Autosaved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored("note.md")?.body).toBe("Autosaved");
  });

  it("returns the read's typed failure for a missing record", async () => {
    const { records } = setup();
    await expect(records.open("missing.md")).resolves.toMatchObject({ ok: false, problem: { code: "file_not_found" } });
  });

  it("shares one session between views, including concurrent opens", async () => {
    const { records, connection } = setup();
    const [first, second] = await Promise.all([open(records), open(records)]);
    expect(first.session).toBe(second.session);
    expect(connection.read).toHaveBeenCalledOnce();
    const third = await open(records);
    expect(third.session).toBe(first.session);
    expect(connection.read).toHaveBeenCalledOnce();
  });

  it("gives a concurrent opener its own read when another caller cancels", async () => {
    const { records, connection } = setup();
    const controller = new AbortController();
    connection.read.mockImplementationOnce(async () => {
      controller.abort();
      return connectFailure(connectProblem("operation_cancelled", "Cancelled"));
    });
    const [cancelled, other] = await Promise.all([
      records.open("note.md", { signal: controller.signal }),
      records.open("note.md")
    ]);
    expect(cancelled).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(other.ok).toBe(true);
  });

  it("keeps saving after the last view releases, then drops the session", async () => {
    const { records, connection, stored } = setup();
    const lease = await open(records);
    lease.session.setBody("Written after release");
    lease.release();
    lease.release();
    const reopened = await open(records);
    expect(reopened.session).toBe(lease.session);
    reopened.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored("note.md")?.body).toBe("Written after release");
    const fresh = await open(records);
    expect(fresh.session).not.toBe(lease.session);
    expect(connection.read).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost response through the durable pending mutation, not a new write", async () => {
    const { records, connection, loseNextResponse } = setup();
    const { session } = await open(records, "note.md", { autosave: false });
    loseNextResponse();
    session.setBody("Lost");
    await expect(session.save()).resolves.toMatchObject({ ok: false, problem: { code: "operation_outcome_unknown" } });
    expect(session.snapshot.state).toBe("recovery");
    await expect(session.flush()).resolves.toMatchObject({ ok: true, value: { body: "Lost" } });
    expect(connection.update).toHaveBeenCalledOnce();
    expect(session.snapshot.state).toBe("saved");
  });

  it("resumes a save interrupted before a reload as exact recovery", async () => {
    const fake = fakeConnection();
    const { connection, loseNextResponse } = fake;
    const before = new MdbaseRecords(connection as never);
    const first = await open(before, "note.md", { autosave: false });
    loseNextResponse();
    first.session.setBody("Lost before reload");
    await first.session.save();

    // A new page: the pending write is found by its record, not replayed as new.
    const after = new MdbaseRecords(connection as never, async (path) => path === "note.md" ? "lost" : null);
    const reopened = await open(after);
    expect(reopened.session.snapshot).toMatchObject({ state: "recovery", pendingRequestId: "lost" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reopened.session.snapshot).toMatchObject({ state: "saved", body: "Lost before reload" });
    expect(connection.update).toHaveBeenCalledOnce();
  });

  it("classifies a revision rejection against the current record", async () => {
    const { records, elsewhere } = setup();
    const { session } = await open(records, "note.md", { autosave: false });
    const remote = elsewhere("note.md", "Remote");
    session.setBody("Local");
    await expect(session.save()).resolves.toMatchObject({ ok: false, problem: { code: "concurrent_modification" } });
    expect(session.snapshot).toMatchObject({ state: "conflict", remote });
  });

  describe("follow", () => {
    it("refreshes a changed record and skips its own write's echo", async () => {
      const { records, connection, watch, emit, elsewhere } = setup();
      records.follow(watch);
      const { session } = await open(records, "note.md", { autosave: false });
      session.setBody("Mine");
      const saved = await session.flush();
      emit("mdbase.record.modified", { path: "note.md", revision: saved.ok ? saved.value.revision : "" });
      await vi.runAllTimersAsync();
      expect(connection.read).toHaveBeenCalledOnce();
      const remote = elsewhere("note.md", "Theirs");
      emit("mdbase.record.modified", { path: "note.md", revision: remote.revision });
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ body: "Theirs", state: "saved" });
    });

    it("follows a rename, so later writes go to the new path", async () => {
      const { records, watch, emit, move, stored } = setup();
      records.follow(watch);
      const { session } = await open(records, "note.md", { autosave: false });
      const moved = move("note.md", "moved.md");
      emit("mdbase.record.renamed", { from: "note.md", to: "moved.md", revision: moved.revision });
      await vi.runAllTimersAsync();
      expect(session.snapshot.record.path).toBe("moved.md");
      session.setBody("After move");
      await expect(session.flush()).resolves.toMatchObject({ ok: true });
      expect(stored("moved.md")?.body).toBe("After move");
      expect((await open(records, "moved.md")).session).toBe(session);
    });

    it("marks a deleted record while keeping local changes", async () => {
      const { records, watch, emit, remove } = setup();
      records.follow(watch);
      const { session } = await open(records, "note.md", { autosave: false });
      session.setBody("Unsaved");
      remove("note.md");
      emit("mdbase.record.deleted", { path: "note.md" });
      await vi.runAllTimersAsync();
      expect(session.snapshot).toMatchObject({ state: "deleted", body: "Unsaved" });
    });

    it("refreshes every open record after a change gap", async () => {
      const { records, watch, reset, elsewhere } = setup();
      records.follow(watch);
      const { session } = await open(records);
      elsewhere("note.md", "Missed");
      reset();
      await vi.runAllTimersAsync();
      expect(session.snapshot.body).toBe("Missed");
    });

    it("stops following when unsubscribed", async () => {
      const { records, watch, emit, elsewhere, connection } = setup();
      const stop = records.follow(watch);
      await open(records);
      stop();
      const remote = elsewhere("note.md", "Ignored");
      emit("mdbase.record.modified", { path: "note.md", revision: remote.revision });
      await vi.runAllTimersAsync();
      expect(connection.read).toHaveBeenCalledOnce();
    });
  });
});
