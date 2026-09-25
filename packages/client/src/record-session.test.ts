import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { connectProblem, MdbaseConnectError } from "./errors.js";
import { RecordSession, type RecordChange, type RecordSessionAdapter } from "./record-session.js";

interface Doc {
  path: string;
  revision: string;
  body: string;
  frontmatter: JsonObject;
}

const original: Doc = { path: "note.md", revision: "1", body: "Original", frontmatter: { title: "Note", tags: ["a"] } };

function doc(body: string, revision = "2", frontmatter: JsonObject = original.frontmatter): Doc {
  return { ...original, body, revision, frontmatter };
}

type Write = Mock<(base: Doc, change: RecordChange) => Promise<Doc>>;

function adapter(overrides: Partial<RecordSessionAdapter<Doc>> & { write?: Write } = {}): RecordSessionAdapter<Doc> & { write: Write } {
  return {
    revision: (record) => record.revision,
    body: (record) => record.body,
    frontmatter: (record) => record.frontmatter,
    write: vi.fn((_base: Doc, change: RecordChange) => Promise.resolve(doc(change.body ?? original.body))),
    ...overrides
  } as RecordSessionAdapter<Doc> & { write: Write };
}

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void; reject(reason: unknown): void } {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function blockFirstWrite(write: Write): (value: Doc) => void {
  const gate = deferred<Doc>();
  write.mockImplementationOnce(() => gate.promise);
  return gate.resolve;
}

const unknownProblem = connectProblem("operation_outcome_unknown", "Response lost", {
  operationOutcome: "unknown", details: { request_id: "original-update" }
});
const unknown = () => new MdbaseConnectError(unknownProblem);
const rejected = () => new MdbaseConnectError(connectProblem("concurrent_modification", "Revision changed", { operationOutcome: "rejected" }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("autosave and coalescing", () => {
  // Reader annotation: "debounces one collection write while keeping keystrokes out of shared notifications"
  it("writes once after the idle interval measured from the last edit", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    for (let i = 0; i < 40; i += 1) {
      session.setBody(`Changed ${String(i)}`);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(session.snapshot.state).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(979);
    expect(transport.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(original, { body: "Changed 39" });
    expect(session.snapshot.state).toBe("saved");
  });

  // Reader source: "notifies every editing view synchronously and never cancels their shared save"
  it("notifies every view synchronously and keeps writing after views unsubscribe", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    let otherView = "";
    const detach = session.subscribe(() => { otherView = session.snapshot.body; });
    session.setBody("First editor");
    expect(otherView).toBe("First editor");
    session.setBody(`${otherView} plus second editor`);
    detach();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(original, { body: "First editor plus second editor" });
  });

  // Reader annotation: "preserves typing during a slow save, rejects stale views and serializes the next write"
  it("serializes one follow-up write and fires it at once when the idle interval already elapsed", async () => {
    const transport = adapter();
    const finish = blockFirstWrite(transport.write);
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("First");
    await vi.advanceTimersByTimeAsync(1000);
    session.setBody("Second");
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.write).toHaveBeenCalledOnce();
    session.receive(doc("First"));
    expect(session.snapshot.remote).toBeNull();
    finish(doc("First"));
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.write).toHaveBeenCalledTimes(2);
    expect(transport.write).toHaveBeenLastCalledWith(doc("First"), { body: "Second" });
    expect(session.snapshot).toMatchObject({ body: "Second", state: "saved" });
    session.receive(original);
    expect(session.snapshot.body).toBe("Second");
  });

  // Editor coordinator: "serializes a newer draft behind an in-flight save"
  it("never runs two writes for one record", async () => {
    const transport = adapter();
    const finish = blockFirstWrite(transport.write);
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("First");
    const saving = session.save();
    session.setBody("Second");
    void session.save();
    expect(transport.write).toHaveBeenCalledOnce();
    finish(doc("First"));
    await saving;
    await session.flush();
    expect(transport.write.mock.calls.map(([, change]) => change.body)).toEqual(["First", "Second"]);
    expect(session.snapshot.state).toBe("saved");
  });

  // Reader source: "never clears an edit typed during an in-flight save"
  it("keeps an edit typed during an in-flight save unsaved", async () => {
    const transport = adapter();
    const finish = blockFirstWrite(transport.write);
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("First");
    const saving = session.save();
    session.setBody("Second");
    finish(doc("First"));
    await saving;
    expect(session.snapshot).toMatchObject({ body: "Second", state: "unsaved" });
  });

  // Reader annotation: "does not discard newer typing when the previous save finishes after an undo"
  it("writes an undo back to the old text once a different save is acknowledged", async () => {
    const transport = adapter();
    const finish = blockFirstWrite(transport.write);
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("First");
    await vi.advanceTimersByTimeAsync(1000);
    session.setBody("Original");
    expect(session.snapshot.dirty).toBe(true);
    finish(doc("First"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.write).toHaveBeenLastCalledWith(doc("First"), { body: "Original" });
    expect(session.snapshot.body).toBe("Original");
  });

  it("runs other record operations in the same queue", async () => {
    const transport = adapter();
    const finish = blockFirstWrite(transport.write);
    const session = new RecordSession(original, transport, { autosave: false });
    const order: string[] = [];
    session.setBody("First");
    const saving = session.save().then(() => order.push("save"));
    const renaming = session.run(async () => { order.push("rename"); });
    await Promise.resolve();
    expect(order).toEqual([]);
    finish(doc("First"));
    await Promise.all([saving, renaming]);
    expect(order).toEqual(["save", "rename"]);
  });
});

describe("acknowledgements and external changes", () => {
  function acknowledgementFixture() {
    const transport = adapter({
      write: vi.fn((_base: Doc, change: RecordChange) => Promise.resolve(doc(change.body ?? "", "4")))
    });
    const finish = blockFirstWrite(transport.write);
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("First");
    const pending = session.save();
    return { session, transport, finish, pending };
  }

  // Reader regression (annotation-save-acknowledgement.test.ts) x2
  it.each([false, true])("recognizes its normalized acknowledgement before the write settles (newer typing: %s)", async (typing) => {
    const { session, transport, finish, pending } = acknowledgementFixture();
    if (typing) session.setBody("Second");
    const acknowledged = doc("First\n");
    session.receive(acknowledged);
    expect(session.snapshot.remote).toBeNull();
    finish(acknowledged);
    await pending;
    expect(session.snapshot.remote).toBeNull();
    expect(session.snapshot.record).toEqual(acknowledged);
    expect(session.snapshot.dirty).toBe(typing);
    if (typing) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(transport.write).toHaveBeenLastCalledWith(acknowledged, { body: "Second" });
    }
  });

  // Reader regression x2
  it.each([false, true])("does not hide another revision behind its acknowledgement (ack first: %s)", async (ackFirst) => {
    const { session, transport, finish, pending } = acknowledgementFixture();
    session.setBody("Second");
    const acknowledged = doc("First\n"), external = doc("Other client\n", "3");
    for (const record of ackFirst ? [acknowledged, external] : [external, acknowledged]) session.receive(record);
    finish(acknowledged);
    await pending;
    expect(session.snapshot).toMatchObject({ state: "conflict", remote: external, body: "Second" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.write).toHaveBeenCalledOnce();
  });

  // Reader regression
  it("still conflicts on another revision's whitespace-only edit", async () => {
    const { session, finish, pending } = acknowledgementFixture();
    session.setBody("Second");
    const acknowledged = doc("First\n"), external = doc("First\n\n", "3");
    session.receive(external);
    session.receive(acknowledged);
    finish(acknowledged);
    await pending;
    expect(session.snapshot.remote).toEqual(external);
    expect(session.snapshot.body).toBe("Second");
  });

  it("treats a normalized acknowledgement as clean without rewriting the draft", async () => {
    const transport = adapter({ write: vi.fn((_b: Doc, change: RecordChange) => Promise.resolve(doc(`${change.body ?? ""}\n`))) });
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("First");
    await session.flush();
    expect(session.snapshot).toMatchObject({ body: "First", dirty: false, state: "saved" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.write).toHaveBeenCalledOnce();
  });

  // Reader source: "ignores stale values from other views after saving a newer revision"
  it("ignores revisions it has already seen", async () => {
    const session = new RecordSession(original, adapter(), { autosave: false });
    session.setBody("New revision");
    await session.save();
    session.receive(original);
    expect(session.snapshot.body).toBe("New revision");
  });

  it("adopts an external change while clean", () => {
    const session = new RecordSession(original, adapter(), { autosave: false });
    session.receive(doc("Remote"));
    expect(session.snapshot).toMatchObject({ body: "Remote", state: "saved", record: doc("Remote") });
  });

  // Editor App: "preserves local edits when a remote change arrives"
  it("keeps local edits and exposes the remote record on a body conflict", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("Local sentence");
    session.receive(doc("Remote sentence"));
    expect(session.snapshot).toMatchObject({ state: "conflict", body: "Local sentence", remote: doc("Remote sentence") });
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.write).not.toHaveBeenCalled();
    await expect(session.flush()).rejects.toThrow();
  });

  // Reader source: "permits metadata-only revision changes"
  it("rebases a body edit onto a metadata-only external change", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Local");
    const metadata = doc("Original", "2", { title: "Renamed elsewhere", tags: ["a"] });
    session.receive(metadata);
    expect(session.snapshot).toMatchObject({ state: "unsaved", remote: null, body: "Local", record: metadata });
    await session.flush();
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(metadata, { body: "Local" });
  });

  it("conflicts only on frontmatter keys changed on both sides and writes only dirty keys", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: false });
    session.patchFrontmatter({ title: "Mine" });
    expect(session.snapshot.frontmatter).toEqual({ title: "Mine", tags: ["a"] });
    const tagsChanged = doc("Original", "2", { title: "Note", tags: ["b"] });
    session.receive(tagsChanged);
    expect(session.snapshot.state).toBe("unsaved");
    await session.flush();
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(tagsChanged, { patch: { title: "Mine" } });

    const second = new RecordSession(original, adapter(), { autosave: false });
    second.patchFrontmatter({ title: "Mine" });
    second.receive(doc("Original", "2", { title: "Theirs", tags: ["a"] }));
    expect(second.snapshot.state).toBe("conflict");
  });

  // Reader annotation: "uses the verified latest base when an older response follows a matching remote edit"
  it("adopts a convergent remote as saved", async () => {
    const remote = doc("Second", "3");
    const transport = adapter({ read: vi.fn(() => Promise.resolve(remote)) });
    const finish = blockFirstWrite(transport.write);
    transport.write.mockRejectedValueOnce(new Error("Revision conflict"));
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("First");
    await vi.advanceTimersByTimeAsync(1000);
    session.setBody("Second");
    session.receive(remote);
    finish(doc("First"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot).toMatchObject({ body: "Second", state: "saved", record: remote });
  });
});

describe("failures, conflicts and resolution", () => {
  // Reader annotation: "keeps failed edits in memory, without background retry loops"
  it("reports a failed write without retrying in the background", async () => {
    const transport = adapter();
    transport.write.mockRejectedValueOnce(new Error("Offline"));
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("Offline text");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot).toMatchObject({ state: "error", body: "Offline text" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.write).toHaveBeenCalledOnce();
    await session.save();
    expect(session.snapshot.state).toBe("saved");
  });

  // Reader source: "retains the draft when offline and retries successfully"
  it("reads once after a failed write and stays in error when that read fails too", async () => {
    const read = vi.fn(() => Promise.reject(new Error("Offline")));
    const transport = adapter({ read });
    transport.write.mockRejectedValueOnce(new Error("Offline"));
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Offline text");
    await expect(session.save()).rejects.toThrow("Offline");
    expect(read).toHaveBeenCalledOnce();
    expect(session.snapshot).toMatchObject({ state: "error", body: "Offline text" });
    await session.save();
    expect(session.snapshot.state).toBe("saved");
  });

  // Reader annotation: "retains conflicts until a revision-checked choice is explicitly saved"
  // Reader source: "requires a choice when the remote body changed, then uses the current revision"
  it("classifies a rejected write through a read and keeps mine against the remote revision", async () => {
    const remote = doc("Remote");
    const transport = adapter({ read: () => Promise.resolve(remote) });
    transport.write.mockRejectedValueOnce(rejected());
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("Local");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot).toMatchObject({ state: "conflict", remote, body: "Local" });
    session.resolve({ keep: "mine" });
    expect(session.snapshot).toMatchObject({ state: "unsaved", remote: null, record: remote });
    await session.save();
    expect(transport.write).toHaveBeenLastCalledWith(remote, { body: "Local" });
  });

  it("rebases and writes again at once when the rejection was a metadata-only change", async () => {
    const metadata = doc("Original", "2", { title: "Elsewhere", tags: ["a"] });
    const transport = adapter({ read: () => Promise.resolve(metadata) });
    transport.write.mockRejectedValueOnce(rejected());
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Local");
    await session.flush();
    expect(transport.write).toHaveBeenLastCalledWith(metadata, { body: "Local" });
    expect(session.snapshot.state).toBe("saved");
  });

  // Reader source: "allows choosing the collection version without overwriting it"
  it("keeps theirs without writing", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Mine");
    session.receive(doc("Remote"));
    session.resolve({ keep: "theirs" });
    expect(session.snapshot).toMatchObject({ body: "Remote", state: "saved", remote: null });
    expect(transport.write).not.toHaveBeenCalled();
  });

  it("resolves with merged text", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Mine");
    session.receive(doc("Theirs"));
    session.resolve({ body: "Mine and theirs" });
    await session.flush();
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(doc("Theirs"), { body: "Mine and theirs" });
  });

  it("accepts its own out-of-band result without conflict and keeps newer typing", () => {
    const session = new RecordSession(original, adapter(), { autosave: false });
    session.setBody("Typed during rename");
    const renamed = { ...original, path: "renamed.md", revision: "7" };
    session.accept(renamed);
    expect(session.snapshot).toMatchObject({ record: renamed, body: "Typed during rename", state: "unsaved", remote: null });
    const clean = new RecordSession(original, adapter(), { autosave: false });
    clean.accept(doc("Replaced source", "8"));
    expect(clean.snapshot).toMatchObject({ body: "Replaced source", state: "saved" });
  });

  it("discards local changes on request", () => {
    const session = new RecordSession(original, adapter(), { autosave: false });
    session.setBody("Discard me");
    session.discard();
    expect(session.snapshot).toMatchObject({ body: "Original", dirty: false, state: "saved" });
  });

  it("retains the draft and stops writing when the record is deleted", async () => {
    const transport = adapter({ read: () => Promise.resolve(null) });
    transport.write.mockRejectedValueOnce(new Error("Not found"));
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("Keep me");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot).toMatchObject({ state: "deleted", body: "Keep me" });
    session.setBody("Still here");
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.write).toHaveBeenCalledOnce();
    await expect(session.flush()).rejects.toThrow();
  });
});

describe("restored drafts", () => {
  // Reader source: "detects conflicting recovery but permits metadata-only revision changes"
  it("restores a local draft against its original base", () => {
    const current = doc("Original", "2");
    const clean = new RecordSession(current, adapter(), { autosave: false });
    clean.restore({ body: "Local", baseBody: "Original" });
    expect(clean.snapshot).toMatchObject({ state: "unsaved", remote: null, body: "Local" });
    const changed = doc("Remote", "2");
    const conflicting = new RecordSession(changed, adapter(), { autosave: false });
    conflicting.restore({ body: "Local", baseBody: "Original" });
    expect(conflicting.snapshot).toMatchObject({ state: "conflict", remote: changed, body: "Local" });
    const unknownBase = new RecordSession(current, adapter(), { autosave: false });
    unknownBase.restore({ body: "Local" });
    expect(unknownBase.snapshot.state).toBe("conflict");
  });

  // Reader source: "resumes safe recovery on mount"; annotation legacy drafts are never submitted on load
  it("does not write a restored draft until autosave is requested", async () => {
    const transport = adapter();
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.restore({ body: "Recovered", baseBody: "Original" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.write).not.toHaveBeenCalled();
    session.autosave();
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(original, { body: "Recovered" });
  });
});

describe("outcome-unknown recovery", () => {
  // Editor coordinator: "recovers the original autosave snapshot before saving changed input"
  it("recovers the original write before saving newer input", async () => {
    const write = vi.fn((_base: Doc, change: RecordChange) => {
      if (write.mock.calls.length === 1) return Promise.reject(unknown());
      return Promise.resolve(doc(change.body ?? "", "3"));
    });
    const recover = vi.fn(() => Promise.resolve(doc("First", "2")));
    const transport = adapter({ write, recover, isPending: () => true });
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("First");
    await expect(session.save()).rejects.toBeInstanceOf(MdbaseConnectError);
    expect(session.snapshot).toMatchObject({ state: "recovery", pendingRequestId: "original-update" });
    session.setBody("Second");
    session.receive(doc("First", "2"));
    expect(session.snapshot.remote).toBeNull();
    await session.flush();
    expect(recover).toHaveBeenCalledExactlyOnceWith("original-update");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]).toEqual([doc("First", "2"), { body: "Second" }]);
    expect(session.snapshot).toMatchObject({ state: "saved", body: "Second" });
  });

  // Editor coordinator: "failed recovery retains the pending identity and never calls update again"
  // Editor recovery: "retains the original intent when recovery is ..."
  it.each([
    ["still unknown", unknown()],
    ["probe not sent", new MdbaseConnectError(connectProblem("temporarily_unavailable", "Probe unavailable", { operationOutcome: "not_sent" }))],
    ["probe rejected but original still pending", rejected()],
    ["unstructured failure", new Error("Offline")]
  ])("retains the original intent when recovery is %s", async (_name, failure) => {
    const write = vi.fn(() => Promise.reject(unknown()));
    const transport = adapter({ write, recover: () => Promise.reject(failure), isPending: () => true });
    const session = new RecordSession(original, transport, { autosave: { idleMs: 1000 } });
    session.setBody("Original accepted intent");
    await expect(session.save()).rejects.toBeInstanceOf(MdbaseConnectError);
    session.setBody("Newer unsent draft");
    for (let i = 0; i < 2; i += 1) await expect(session.save()).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledOnce();
    expect(session.snapshot).toMatchObject({ state: "recovery", pendingRequestId: "original-update", body: "Newer unsent draft" });
  });

  // Editor recovery: "exact continuation settles the original pending identity" (definitive modes)
  it("clears the pending identity when the SDK settles it with a definitive rejection", async () => {
    let pending = true;
    const remote = doc("Remote");
    const transport = adapter({
      write: vi.fn(() => Promise.reject(unknown())),
      recover: () => { pending = false; return Promise.reject(rejected()); },
      isPending: () => pending,
      read: () => Promise.resolve(remote)
    });
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Keep this draft");
    await expect(session.save()).rejects.toBeInstanceOf(MdbaseConnectError);
    await session.save().catch(() => undefined);
    expect(session.snapshot).toMatchObject({ state: "conflict", body: "Keep this draft", remote });
    expect(session.snapshot.pendingRequestId).toBeUndefined();
    expect(transport.write).toHaveBeenCalledOnce();
  });

  it("refuses to write when exact recovery is unavailable", async () => {
    const transport = adapter();
    transport.write.mockRejectedValueOnce(unknown());
    const session = new RecordSession(original, transport, { autosave: false });
    session.setBody("Intent");
    await expect(session.save()).rejects.toBeInstanceOf(MdbaseConnectError);
    await expect(session.save()).rejects.toThrow("No new write was attempted");
    expect(transport.write).toHaveBeenCalledOnce();
  });
});
