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
    // SDK811's shared synthetic fixture now honors document creation; no
    // app-side parser bridge. This remains SDK stand-in, not native/LAB proof.
    const create = vi.spyOn(f.client, "create");
    const restored = await f.adapter.restore(created);
    expect(create).toHaveBeenCalledWith({ id: expect.any(String), path: created.path, document: created.document }, expect.objectContaining({ mutationId: expect.any(String) }));
    expect(restored.body).toBe(created.body);
    expect(restored.frontmatter).toEqual(created.frontmatter);
  });

  it("a create retried with the same ID after a lost reply lands once", async () => {
    const f = await fixture();
    const original = f.client.create.bind(f.client);
    vi.spyOn(f.client, "create").mockImplementationOnce(async (input, options) => {
      await original(input, options);
      throw new Error("Reply lost");
    });
    const input = { id: crypto.randomUUID(), title: "Once", body: "", path: "notes/once.md", properties: {} };
    await expect(f.adapter.create(input)).rejects.toThrow("Reply lost");
    const created = await f.adapter.create(input);
    expect(created.path).toBe("notes/once.md");
    expect((await f.client.query({})).records.filter(r => r.path.startsWith("notes/once")).map(r => r.id)).toEqual([input.id]);
  });

  it("an edited create retried after a lost reply lands once, then applies the edit", async () => {
    const f = await fixture();
    const original = f.client.create.bind(f.client);
    vi.spyOn(f.client, "create").mockImplementationOnce(async (input, options) => {
      await original(input, options);
      throw new Error("Reply lost");
    });
    const id = crypto.randomUUID();
    await expect(f.adapter.create({ id, title: "Draft", body: "first", path: "notes/draft.md", titleField: "title", properties: { title: "Draft", stale: true } })).rejects.toThrow("Reply lost");
    const created = await f.adapter.create({ id, title: "Final", body: "edited", path: "notes/final.md", titleField: "title", properties: { title: "Final" } });
    expect([created.path, created.body, created.frontmatter]).toEqual(["notes/final.md", "edited", { title: "Final" }]);
    expect((await f.client.query({})).records.filter(r => r.path !== "notes/plan.md").map(r => r.id)).toEqual([id]);
  });

  it("retains outcome-unknown for exact receipt recovery without a new update", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const original = f.client.update.bind(f.client);
    const update = vi.spyOn(f.client, "update").mockImplementation(async (target, input, options) => {
      await original(target, input, options);
      throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: "Unknown" });
    });
    const receipt = vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "unknown" }));
    await expect(f.adapter.updateProperties(base.path, { status: "done" }, base.revision)).rejects.toMatchObject({ code: "outcome_unknown" });
    const [mutation] = f.adapter.pendingMutations();
    await expect(f.adapter.updateProperties(base.path, { status: "open" }, base.revision)).rejects.toThrow("Check your unconfirmed change");
    receipt.mockRestore();
    await f.adapter.recover(mutation.mutationId);
    expect(update).toHaveBeenCalledTimes(1);
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("fails plainly, with nothing to recover, when the replica never captured the write", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    vi.spyOn(f.client, "update").mockRejectedValueOnce(new MdbaseError({ code: "unavailable", recovery: "retry", message: "Offline" }));
    await expect(f.adapter.updateProperties(base.path, { status: "done" }, base.revision)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.adapter.pendingMutations()).toEqual([]);
    expect((await f.adapter.updateProperties(base.path, { status: "done" }, base.revision))?.frontmatter.status).toBe("done");
  });

  it("a save still waiting for its receipt (offline) is not reported as interrupted", async () => {
    const f = await fixture(true);
    const base = await f.adapter.read(f.record.path);
    const update = vi.spyOn(f.client, "update");
    const saving = f.adapter.updateProperties(base.path, { status: "done" }, base.revision);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(f.adapter.pendingMutations()).toEqual([]);
    f.replica.confirmAll();
    expect((await saving)?.frontmatter.status).toBe("done");
    expect(f.adapter.pendingMutations()).toEqual([]);
  });

  it("reports a write the log has not confirmed as saved on this device, with nothing to recover", async () => {
    const f = await fixture(true);
    const base = await f.adapter.read(f.record.path);
    vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
    expect((await f.adapter.updateProperties(base.path, { status: "done" }, base.revision))?.frontmatter.status).toBe("done");
    expect(f.adapter.pendingMutations()).toEqual([]);
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

  it("treats a captured write as saved after an ambiguous internal SDK response error", async () => {
    const f = await fixture();
    const base = await f.adapter.read(f.record.path);
    const original = f.client.update.bind(f.client);
    const update = vi.spyOn(f.client, "update").mockImplementation(async (target, input, options) => {
      await original(target, input, options);
      throw new MdbaseError({ code: "internal", recovery: "contact_support", reason: "invalid_submit_result", message: "Post-capture response shape error" });
    });
    expect((await f.adapter.updateProperties(base.path, { title: "Changed" }, base.revision))?.frontmatter.title).toBe("Changed");
    expect(f.adapter.pendingMutations()).toEqual([]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("ignores late source replies after its repository lifetime is closed", async () => {
    const f = await fixture();
    const record = await f.client.get(f.record.id, { body: true, document: true });
    vi.spyOn(f.client, "get").mockImplementation(async () => { f.adapter.dispose(); return record; });
    await expect(f.adapter.read(record.path)).rejects.toMatchObject({ name: "AbortError" });
  });
});
