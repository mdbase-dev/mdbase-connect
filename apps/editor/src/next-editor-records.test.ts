import { connect, MdbaseError, type MdbaseClient } from "@mdbase-dev/sdk";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextEditorRecords } from "./next-editor-records";

const clients: MdbaseClient[] = [];
const adapters: NextEditorRecords[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

async function fixture(pending = false) {
  const replica = new MemoryReplica({ confirmDelayMs: pending ? null : 0 });
  const record = replica.seed({ path: "notes/plan.md", frontmatter: { title: "Plan", status: "open" }, body: "Original body\n" });
  const client = await connect({ connector: replica.connector(), app: { name: "editor-record-test", version: "test" }, reconnect: false });
  clients.push(client);
  const adapter = new NextEditorRecords(client);
  adapters.push(adapter);
  return { replica, client, record, adapter };
}

describe("NextEditorRecords (SDK stand-in, not LAB)", () => {
  it("returns the genuine complete document and does not invent file metadata", async () => {
    const f = await fixture();
    const get = vi.spyOn(f.client, "get");
    const note = await f.adapter.read("notes/plan.md");
    expect(note.body).toBe("Original body\n");
    expect(note.document).toContain("Original body");
    expect(note.effectiveFrontmatter.title).toBe("Plan");
    expect(get).toHaveBeenCalledWith({ path: "notes/plan.md" }, { body: true, effective: true, document: true }, expect.any(AbortSignal));
    expect(note.file).toEqual({ path: "notes/plan.md" });
  });

  it("refuses absent source bytes rather than reconstructing formatted YAML", async () => {
    const f = await fixture();
    const record = await f.client.get(f.record.id, { body: true });
    vi.spyOn(f.client, "get").mockResolvedValue(record);
    await expect(f.adapter.read(record.path)).rejects.toThrow("complete note source");
  });

  it("saves only the changed fields/body against the original genuine base", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const update = vi.spyOn(f.client, "update");
    const saved = await f.adapter.update(base, { patch: { status: "done" }, body: "Changed body\n" });
    expect(saved.body).toBe("Changed body\n");
    expect(saved.frontmatter.status).toBe("done");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: f.record.id, revision: base.revision }),
      { patch: { status: "done" }, body: "Changed body\n", ifRevision: base.revision },
      expect.objectContaining({ mutationId: expect.any(String), signal: expect.any(AbortSignal) }));
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("uses native document replacement and preserves explicit revision CAS", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const replace = vi.spyOn(f.client, "replaceDocument");
    const source = "---\ntitle: Exact\n---\nSource body\n";
    const saved = await f.adapter.updateDocument(base.path, source, base.revision);
    expect(saved.frontmatter.title).toBe("Exact");
    expect(saved.body).toBe("Source body\n");
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ id: f.record.id }), source, expect.objectContaining({ ifRevision: base.revision }));
  });

  it("rejects an unobserved revision instead of reading a fresh base for a stale edit", async () => {
    const f = await fixture();
    const update = vi.spyOn(f.client, "update");
    await expect(f.adapter.updateProperties(f.record.path, { status: "done" }, "stale")).rejects.toMatchObject({ code: "conflict", reason: "revision_mismatch" });
    expect(update).not.toHaveBeenCalled();
  });

  it("uses genuine native rename and delete preflights", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const rename = vi.spyOn(f.client, "preflightRename");
    const remove = vi.spyOn(f.client, "preflightDelete");
    await f.adapter.preflightRename(base.path, "notes/new.md", base.revision);
    await f.adapter.preflightDelete(base.path, base.revision);
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ id: f.record.id }), "notes/new.md", { updateRefs: true });
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: f.record.id }));
  });

  it("renames and deletes through confirmed native operations", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const moved = await f.adapter.rename(base.path, "notes/moved.md", base.revision);
    expect(moved.path).toBe("notes/moved.md");
    await f.adapter.delete(moved.path, moved.revision);
    expect(await f.client.find(f.record.id)).toBeNull();
  });

  it("creates/restores full records without provisioning app-specific definitions", async () => {
    const f = await fixture();
    const created = await f.adapter.create({ title: "Heading", body: "Text", path: "notes/new.md", properties: {} });
    expect(created.body).toContain("# Heading");
    await f.adapter.delete(created.path, created.revision);
    // MemoryReplica does not parse create.document. Keep the adapter's exact
    // source submission observable, then supply the native document-create
    // behavior only in this test; this is not source-parser/LAB evidence.
    const originalCreate = f.client.create.bind(f.client);
    const create = vi.spyOn(f.client, "create").mockImplementation((input, options) =>
      originalCreate({ ...input, frontmatter: {}, body: created.body }, options));
    const restored = await f.adapter.restore(created);
    expect(create).toHaveBeenCalledWith({ id: expect.any(String), path: created.path, document: created.document }, expect.objectContaining({ mutationId: expect.any(String) }));
    expect(restored.body).toBe(created.body);
    expect(restored.frontmatter).toEqual(created.frontmatter);
  });

  it("retains outcome-unknown for exact receipt recovery without a new update", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const update = vi.spyOn(f.client, "update").mockRejectedValue(new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: "Unknown" }));
    await expect(f.adapter.updateProperties(base.path, { status: "done" }, base.revision)).rejects.toMatchObject({ code: "outcome_unknown" });
    const [mutation] = f.adapter.pendingMutations();
    await expect(f.adapter.updateProperties(base.path, { status: "open" }, base.revision)).rejects.toThrow("Recover the interrupted");
    vi.spyOn(f.client, "awaitReceipt").mockResolvedValue({ mutation: mutation.mutationId, state: "confirmed", status: "applied" });
    await f.adapter.recover(mutation.mutationId);
    expect(update).toHaveBeenCalledTimes(1);
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("never reports a pending receipt as a saved note", async () => {
    const f = await fixture(true);
    const base = await f.adapter.read(f.record.path);
    const receipt = vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
    const update = vi.spyOn(f.client, "update");
    await expect(f.adapter.updateProperties(base.path, { status: "done" }, base.revision)).rejects.toMatchObject({ code: "outcome_unknown" });
    const [mutation] = f.adapter.pendingMutations();
    await expect(f.adapter.recover(mutation.mutationId)).rejects.toMatchObject({ code: "outcome_unknown" });
    receipt.mockRestore();
    f.replica.confirmAll();
    expect((await f.adapter.recover(mutation.mutationId))?.frontmatter.status).toBe("done");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("retains a confirmed create when readback fails so recovery cannot create a duplicate", async () => {
    const f = await fixture();
    const original = f.client.get.bind(f.client);
    const get = vi.spyOn(f.client, "get").mockRejectedValueOnce(new MdbaseError({ code: "unavailable", recovery: "retry", message: "Read unavailable" })).mockImplementation(original);
    const create = vi.spyOn(f.client, "create");
    await expect(f.adapter.create({ title: "One", body: "Body", path: "notes/one.md", properties: {} })).rejects.toMatchObject({ code: "unavailable" });
    const [mutation] = f.adapter.pendingMutations();
    expect(mutation.operation).toBe("create");
    const recovered = await f.adapter.recover(mutation.mutationId);
    expect(recovered?.path).toBe("notes/one.md");
    expect(get).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.replica.allRecords.filter(record => record.path === "notes/one.md")).toHaveLength(1);
  });

  it("restores exact native pending mutation IDs after a new adapter opens", async () => {
    const f = await fixture(true);
    const current = await f.client.get(f.record.id, { body: true, effective: true, document: true });
    const write = await f.client.update(current, { patch: { status: "done" }, ifRevision: current.revision });
    await f.adapter.restorePending();
    expect(f.adapter.pendingMutations()).toEqual([expect.objectContaining({ mutationId: write.mutationId, operation: "update", recordId: f.record.id })]);
    f.replica.confirmAll();
    expect((await f.adapter.recover(write.mutationId))?.frontmatter.status).toBe("done");
  });

  it("refuses protected records before any submission", async () => {
    const f = await fixture();
    const record = await f.client.get(f.record.id, { body: true, effective: true, document: true });
    vi.spyOn(f.client, "get").mockResolvedValue({ ...record, state: { ...record.state, unresolved: 1 } });
    const base = await f.adapter.read(record.path);
    const update = vi.spyOn(f.client, "update");
    await expect(f.adapter.updateProperties(base.path, { status: "done" }, base.revision)).rejects.toMatchObject({ code: "conflict", reason: "protected_edit" });
    expect(update).not.toHaveBeenCalled();
  });

  it("never publishes a readback for a different receipt mutation", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    vi.spyOn(f.client, "awaitReceipt").mockResolvedValue({ mutation: crypto.randomUUID(), state: "confirmed" });
    await expect(f.adapter.updateProperties(base.path, { status: "done" }, base.revision)).rejects.toThrow("receipt changed its mutation identity");
    expect(f.adapter.pendingMutations()).toHaveLength(1);
  });

  it("refuses a metadata-only fallback base before submitting document replacement", async () => {
    const f = await fixture(true);
    const partial = await f.client.get(f.record.id, { body: true });
    vi.spyOn(f.client, "get").mockResolvedValue(partial);
    const replace = vi.spyOn(f.client, "replaceDocument");
    vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
    await expect(f.adapter.updateDocument(partial.path, "Replacement\n", partial.revision)).rejects.toBeDefined();
    expect(replace).not.toHaveBeenCalled();
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("refuses a complete source whose bytes do not match the native fallback revision", async () => {
    const f = await fixture();
    const record = await f.client.get(f.record.id, { body: true, document: true });
    // Controlled malformed read response, not native parser qualification.
    vi.spyOn(f.client, "get").mockResolvedValue({ ...record, document: `${record.document}\n` });
    const replace = vi.spyOn(f.client, "replaceDocument");
    await expect(f.adapter.updateDocument(record.path, "Replacement\n", record.revision)).rejects.toThrow("does not match its native revision");
    expect(replace).not.toHaveBeenCalled();
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("retains a confirmed mutation while current readback has unresolved protection", async () => {
    const f = await fixture(true);
    const base = await f.adapter.read(f.record.path);
    const originalGet = f.client.get.bind(f.client);
    const get = vi.spyOn(f.client, "get").mockImplementation(async (ref, include, signal) => {
      const record = await originalGet(ref, include, signal);
      // Controlled protected read response; MemoryReplica does not merge holds.
      return { ...record, state: { ...record.state, unresolved: 1 } };
    });
    const originalReceipt = f.client.awaitReceipt.bind(f.client);
    const receipt = vi.spyOn(f.client, "awaitReceipt").mockImplementation(async (mutation, timeout, signal) => {
      f.replica.confirmAll();
      return originalReceipt(mutation, timeout, signal);
    });
    await expect(f.adapter.updateProperties(base.path, { title: "Changed" }, base.revision)).rejects.toMatchObject({ code: "outcome_unknown", reason: "unqualified_readback" });
    const [mutation] = f.adapter.pendingMutations();
    expect((await f.client.receipt(mutation.mutationId)).state).toBe("confirmed");
    get.mockRestore();
    receipt.mockRestore();
    expect((await f.adapter.recover(mutation.mutationId))?.frontmatter.title).toBe("Changed");
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("retains the original mutation when a genuine applied receipt has pending current readback", async () => {
    const f = await fixture(true);
    const base = await f.adapter.read(f.record.path);
    const awaitReceipt = f.client.awaitReceipt.bind(f.client);
    const receipt = vi.spyOn(f.client, "awaitReceipt").mockImplementation(async (mutation, timeout, signal) => {
      f.replica.confirmAll();
      const confirmed = await awaitReceipt(mutation, timeout, signal);
      expect(confirmed.state).toBe("confirmed");
      expect(confirmed.status).toBe("applied");
      const current = await f.client.get(f.record.id, { body: true, document: true });
      // A second actual SDK write captures after the first receipt but before
      // the adapter's readback. Its optimistic body is not a saved note.
      await f.client.update(current, { body: "Other pending body\n", ifRevision: current.revision });
      expect((await f.client.get(f.record.id)).state.state).toBe("pending");
      return confirmed;
    });
    const update = vi.spyOn(f.client, "update");
    await expect(f.adapter.updateProperties(base.path, { title: "Changed" }, base.revision)).rejects.toBeDefined();
    const [mutation] = f.adapter.pendingMutations();
    expect(mutation).toBeDefined();
    receipt.mockRestore();
    f.replica.confirmAll();
    expect((await f.adapter.recover(mutation.mutationId))?.body).toBe("Other pending body\n");
    expect(update).toHaveBeenCalledTimes(2); // original update + independent consumer
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("retains the exact captured mutation after an ambiguous internal SDK response error", async () => {
    const f = await fixture(true);
    const base = await f.adapter.read(f.record.path);
    const original = f.client.update.bind(f.client);
    let captured = "";
    const update = vi.spyOn(f.client, "update").mockImplementation(async (target, input, options) => {
      const write = await original(target, input, options);
      captured = write.mutationId;
      throw new MdbaseError({ code: "internal", recovery: "contact_support", reason: "invalid_submit_result", message: "Post-capture response shape error" });
    });
    await expect(f.adapter.updateProperties(base.path, { title: "Changed" }, base.revision)).rejects.toMatchObject({ code: "internal" });
    expect((await f.client.pendingWrites()).some(pending => pending.receipt.mutation === captured)).toBe(true);
    expect(f.adapter.pendingMutations()).toEqual([expect.objectContaining({ mutationId: captured })]);
    f.replica.confirmAll();
    expect((await f.adapter.recover(captured))?.frontmatter.title).toBe("Changed");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("ignores late source replies after its repository lifetime is closed", async () => {
    const f = await fixture();
    const record = await f.client.get(f.record.id, { body: true, document: true });
    vi.spyOn(f.client, "get").mockImplementation(async () => { f.adapter.dispose(); return record; });
    await expect(f.adapter.read(record.path)).rejects.toMatchObject({ name: "AbortError" });
  });
});
