// Real SDK over MemoryReplica: protocol/lease grammar, not native/LAB qualification.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseError, mdbaseError, type MdbaseClient, type RecordLease } from "../src/index.js";
import { connect } from "../src/thin-client.js";
import { MemoryReplica } from "../src/testing/index.js";
const clients: MdbaseClient[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.restoreAllMocks();
});
async function fixture(pending = false, role: "owner" | "viewer" = "owner") {
    const replica = new MemoryReplica({ confirmDelayMs: pending ? null : 0, role });
    const record = replica.seed({
        path: "notes/writing.md",
        body: "Original body\n",
        frontmatter: { title: "Original" },
    });
    const client = await connect({
        connector: replica.connector(),
        app: { name: "writer-test", version: "test" },
        reconnect: false,
    });
    clients.push(client);
    return { client, replica, record };
}
async function untilCaptured(lease: RecordLease): Promise<string> {
    await vi.waitFor(() =>
        expect(lease.session.getSnapshot().recovery).not.toBeNull(),
    );
    return lease.session.getSnapshot().recovery!.mutationId;
}
describe("shared native record leases", () => {
    it("carries requireLive into the captured save and rejects a conflicting lease policy", async () => {
        const { client, record } = await fixture();
        const update = vi.spyOn(client, "update");
        const lease = await client.records.open(record.id, { requireLive: true });
        await expect(client.records.open(record.id)).rejects.toMatchObject({reason: "record_lease_policy"});
        lease.session.setBody("Keep my edit");
        expect(await lease.session.flush()).toMatchObject({ok: true});
        expect(update.mock.calls[0]?.[1]).toMatchObject({requireLive: true, body: "Keep my edit"});
        lease.release();
    });
    it("opens a full native document and saves body/fields using original UUID/revision and real confirmation", async () => {
        const f = await fixture(),
            update = vi.spyOn(f.client, "update");
        const lease = await f.client.records.open(f.record.id, {
            autosave: false,
        });
        const base = lease.session.getSnapshot();
        expect(base.state).toBe("saved");
        expect(base.record.document).toContain("Original body");
        lease.session.setBody("Edited\n");
        lease.session.patchFrontmatter({ title: "Changed" });
        expect(await lease.session.flush()).toMatchObject({
            ok: true,
            record: { id: f.record.id, state: { state: "confirmed" } },
        });
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                id: f.record.id,
                revision: base.record.revision,
                document: base.record.document,
            }),
            expect.objectContaining({
                ifRevision: base.record.revision,
                body: "Edited\n",
                patch: new Map([["title", "Changed"]]),
            }),
            expect.objectContaining({
                mutationId: expect.any(String),
                conflictMode: "reject",
                signal: expect.any(AbortSignal),
            }),
        );
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "saved",
            body: "Edited\n",
            dirty: false,
            recovery: null,
            lastReceipt: {
                state: "confirmed",
                mutation: update.mock.calls[0]![2]!.mutationId,
            },
        });
        lease.release();
    });
    it("shares one session across UUID/path leases, release is local and idempotent", async () => {
        const f = await fixture(),
            a = await f.client.records.open({ path: f.record.path }),
            b = await f.client.records.open(f.record.id);
        a.session.setBody("shared draft");
        expect(b.session.getSnapshot().body).toBe("shared draft");
        a.release();
        a.release();
        expect(() => a.session.setBody("bad")).toThrow();
        expect(await b.session.flush()).toMatchObject({ ok: true });
        b.release();
        expect(f.client.link).not.toBe("closed");
    });
    it("keeps a still-pending write on the device, settles it from the ledger and never resubmits", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id),
            update = vi.spyOn(f.client, "update");
        const receipt = vi
            .spyOn(f.client, "awaitReceipt")
            .mockImplementation(async (mutation) => ({
                mutation,
                state: "pending",
            }));
        lease.session.setBody("Pending\n");
        expect(await lease.session.flush()).toMatchObject({
            ok: true,
            saved: "on_device",
        });
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "saved_on_device",
            recovery: null,
            dirty: false,
        });
        const mutation = update.mock.calls[0]![2]!.mutationId!;
        expect(f.client.ledger.getSnapshot().pending).toEqual([
            expect.objectContaining({ mutationId: mutation, records: [f.record.id] }),
        ]);
        expect(f.client.ledger.stateOf(f.record.id)).not.toBe("saved");
        receipt.mockRestore();
        f.replica.confirmAll();
        await vi.waitFor(() =>
            expect(lease.session.getSnapshot().state).toBe("saved"),
        );
        await vi.waitFor(() =>
            expect(f.client.ledger.getSnapshot()).toMatchObject({ pending: [], saveState: "saved" }),
        );
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it.each([false, true])("keeps both bodies after a late rejection (reopen %s)", async (reopen) => {
        const f = await fixture(true);
        let lease = await f.client.records.open(f.record.id);
        vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
        lease.session.setBody("Offline body");
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        const { receipt } = (await f.client.pendingWrites())[0]!;
        if (reopen) {
            lease.release();
            const client = await f.replica.client();
            clients.push(client);
            lease = await client.records.open(f.record.id);
            expect(lease.session.getSnapshot().body).toBe("Offline body");
        }
        f.replica.reject(receipt.mutation);
        f.replica.editElsewhere(f.record.id, { body: "Other device" });
        await vi.waitFor(() => expect(lease.session.getSnapshot()).toMatchObject({
            state: "conflict", body: "Offline body", remote: { body: "Other device" },
        }));
        expect(await lease.session.flush()).toMatchObject({ ok: false });
        expect(lease.session.getSnapshot().body).toBe("Offline body");
        lease.session.resolve({ keep: "mine" });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "unsaved", body: "Offline body" });
        lease.release();
    });
    it("keeps the original mutation while its pending receipt and body readback disagree", async () => {
        const f = await fixture(true);
        const lease = await f.client.records.open(f.record.id);
        const update = vi.spyOn(f.client, "update");
        const receipt = vi.spyOn(f.client, "awaitReceipt").mockImplementationOnce(async mutation => {
            f.replica.reject(mutation);
            f.replica.editElsewhere(f.record.id, { body: "Other device" });
            return { mutation, state: "pending" };
        });
        lease.session.setBody("Offline body");
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { reason: "unqualified_readback" } });
        expect(lease.session.getSnapshot()).toMatchObject({ body: "Offline body", recovery: { mutationId: expect.any(String) } });
        receipt.mockRestore();
        expect(await lease.session.flush()).toMatchObject({ ok: false });
        expect(lease.session.getSnapshot()).toMatchObject({ body: "Offline body", recovery: null });
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it.each([false, true])("restores refused fields and unsets without reverting peer edits (reopen %s)", async reopen => {
        const f = await fixture(true);
        let client = f.client;
        let lease = await client.records.open(f.record.id);
        vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
        lease.session.patchFrontmatter({ category: "local", title: undefined });
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        const { mutationId } = f.client.ledger.getSnapshot().pending[0]!;
        if (reopen) {
            lease.release();
            client = await f.replica.client();
            clients.push(client);
            lease = await client.records.open(f.record.id);
        }
        // An edit made after local acceptance must survive rejection too.
        lease.session.patchFrontmatter({ category: "later typing" });
        f.replica.reject(mutationId);
        await vi.waitFor(() => expect(lease.session.getSnapshot().state).toBe("conflict"));
        f.replica.editElsewhere(f.record.id, { body: "peer body", frontmatter: { extra: "peer field" } });
        await vi.waitFor(() => expect(lease.session.getSnapshot()).toMatchObject({
            state: "conflict", remote: { body: "peer body", frontmatter: { title: "Original", extra: "peer field" } },
        }));
        lease.session.resolve({ keep: "mine" });
        expect(lease.session.getSnapshot().body).toBe("peer body");
        expect(lease.session.getSnapshot().frontmatter).toEqual({ category: "later typing", extra: "peer field" });
        vi.spyOn(client, "awaitReceipt").mockImplementationOnce(async mutation => {
            f.replica.confirmAll();
            return client.receipt(mutation);
        });
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        const saved = await client.get(f.record.id, { include: { body: true } });
        expect(saved.body).toBe("peer body");
        expect(saved.frontmatter).toEqual({ category: "later typing", extra: "peer field" });
        lease.release();
    });
    it.each(["set", "unset"])("retains a divergent pending field %s and subsequent typing", async mode => {
        const f = await fixture(true), lease = await f.client.records.open(f.record.id);
        const update = vi.spyOn(f.client, "update");
        vi.spyOn(f.client, "awaitReceipt").mockImplementationOnce(async mutation => {
            lease.session.patchFrontmatter({ later: "typed during save" });
            f.replica.reject(mutation);
            return { mutation, state: "pending" };
        });
        lease.session.patchFrontmatter({ title: mode === "set" ? "local" : undefined });
        const expected = mode === "set" ? { title: "local", later: "typed during save" } : { later: "typed during save" };
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { reason: "unqualified_readback" } });
        expect(lease.session.getSnapshot().frontmatter).toEqual(expected);
        const mutation = update.mock.calls[0]![2]!.mutationId;
        expect(lease.session.getSnapshot().recovery?.mutationId).toBe(mutation);
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code: "conflict" } });
        expect(lease.session.getSnapshot().lastReceipt).toMatchObject({ mutation, state: "rejected" });
        expect(lease.session.getSnapshot().frontmatter).toEqual(expected);
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it("accepts another offline edit and adopts a peer edit following genuine confirmation", async () => {
        const f = await fixture(true), lease = await f.client.records.open(f.record.id);
        const update = vi.spyOn(f.client, "update");
        vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
        lease.session.patchFrontmatter({ title: "Offline title" });
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        lease.session.setBody("Offline body");
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        f.replica.confirmAll();
        f.replica.editElsewhere(f.record.id, { body: "Later peer body", frontmatter: { title: "Later peer title" } });
        await vi.waitFor(() => expect(lease.session.getSnapshot()).toMatchObject({
            state: "saved", body: "Later peer body", frontmatter: { title: "Later peer title" }, remote: null,
        }));
        expect(update).toHaveBeenCalledTimes(2);
        lease.release();
    });
    it("adopts a confirmed record that already contains the newer draft after rollback", async () => {
        const f = await fixture(true), lease = await f.client.records.open(f.record.id);
        const update = vi.spyOn(f.client, "update");
        vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
        lease.session.setBody("First");
        lease.session.patchFrontmatter({ title: undefined });
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        const { mutationId } = f.client.ledger.getSnapshot().pending[0]!;
        lease.session.setBody("Second");
        lease.session.patchFrontmatter({ title: "Second" });
        f.replica.reject(mutationId);
        f.replica.editElsewhere(f.record.id, { body: "Second", frontmatter: { title: "Second" } });
        await vi.waitFor(() => expect(lease.session.getSnapshot()).toMatchObject({
            state: "saved", dirty: false, body: "Second", frontmatter: { title: "Second" }, remote: null,
            lastReceipt: { mutation: mutationId, state: "rejected" },
        }));
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it("holds later typing for review when a peer edits the body between confirmation and readback", async () => {
        const f = await fixture(true), lease = await f.client.records.open(f.record.id);
        const update = vi.spyOn(f.client, "update");
        vi.spyOn(f.client, "awaitReceipt").mockImplementationOnce(async mutation => {
            lease.session.setBody("Later typing");
            f.replica.confirmAll();
            f.replica.editElsewhere(f.record.id, { body: "Peer after confirmation" });
            return f.client.receipt(mutation);
        });
        lease.session.setBody("First draft");
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code: "conflict" } });
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "conflict", body: "Later typing", remote: { body: "Peer after confirmation" },
            recovery: null, lastReceipt: { state: "confirmed" },
        });
        expect(await lease.session.flush()).toMatchObject({ ok: false });
        expect(update).toHaveBeenCalledTimes(1);
        expect((await f.client.get(f.record.id, { include: { body: true } })).body).toBe("Peer after confirmation");
        lease.session.resolve({ keep: "mine" });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "unsaved", body: "Later typing" });
        lease.release();
    });
    it("keeps matching readbacks editable on device until the exact receipt confirms", async () => {
        const f = await fixture(true), lease = await f.client.records.open(f.record.id);
        const get = f.client.get.bind(f.client);
        vi.spyOn(f.client, "get").mockImplementation(async (...args) => {
            const row = await get(...args);
            return { ...row, state: { ...row.state, state: "confirmed" } };
        });
        vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
        lease.session.setBody("Local");
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        lease.session.patchFrontmatter({ title: undefined });
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        expect(lease.session.getSnapshot().lastReceipt?.state).toBe("pending");
        expect(lease.session.getSnapshot().frontmatter).toEqual({});
        f.replica.confirmAll();
        await vi.waitFor(() => expect(lease.session.getSnapshot()).toMatchObject({
            state: "saved", lastReceipt: { state: "confirmed" },
        }));
        lease.release();
    });
    it.each([false, true])("discards a refresh spanning an offline write (stale failure %s)", async fail => {
        const f = await fixture(true);
        const original = f.client.get.bind(f.client);
        let finish!: () => void;
        const blocked = new Promise<void>(resolve => { finish = resolve; });
        let replayed!: () => void;
        const replay = new Promise<void>(resolve => { replayed = resolve; });
        const get = vi.spyOn(f.client, "get").mockImplementationOnce(original)
            .mockImplementationOnce(async (...args) => {
                const earlier = await original(...args);
                await blocked;
                if (fail) throw mdbaseError("not_found", "stale refresh");
                return earlier;
            });
        const lease = await f.client.records.open(f.record.id);
        const states: string[] = [];
        lease.session.subscribe(() => states.push(lease.session.getSnapshot().state));
        vi.spyOn(f.client, "awaitReceipt").mockImplementation(async mutation => ({ mutation, state: "pending" }));
        lease.session.setBody("Offline body");
        expect(await lease.session.flush()).toMatchObject({ ok: true, saved: "on_device" });
        get.mockImplementationOnce(async (...args) => {
            replayed();
            return original(...args);
        });
        finish();
        await replay;
        expect(states).not.toContain("conflict");
        expect(states).not.toContain("deleted");
        expect(lease.session.getSnapshot()).toMatchObject({ state: "saved_on_device", body: "Offline body" });
        lease.release();
    });
    it("an offline autosave whose receipt wait runs out is saved on device, then saved once online", async () => {
        const f = await fixture(false),
            update = vi.spyOn(f.client, "update");
        const lease = await f.client.records.open(f.record.id, {
            autosave: { idleMs: 50 },
        });
        f.replica.setOnline(false);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        try {
            lease.session.setBody("Offline edit\n");
            await vi.advanceTimersByTimeAsync(32_000);
            expect(lease.session.getSnapshot()).toMatchObject({
                state: "saved_on_device",
                problem: null,
                recovery: null,
                dirty: false,
            });
            f.replica.setOnline(true);
            await vi.advanceTimersByTimeAsync(100);
        } finally {
            vi.useRealTimers();
        }
        await vi.waitFor(() =>
            expect(lease.session.getSnapshot()).toMatchObject({
                state: "saved",
                body: "Offline edit\n",
                recovery: null,
            }),
        );
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it("retains the exact MID after post-capture internal failure and does not resubmit", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id),
            original = f.client.update.bind(f.client);
        let mid = "";
        const update = vi
            .spyOn(f.client, "update")
            .mockImplementation(async (target, input, options) => {
                const write = await original(target, input, options);
                mid = write.mutationId;
                throw new MdbaseError({
                    code: "internal",
                    recovery: "contact_support",
                    message: "postcapture reply error",
                });
            });
        lease.session.setBody("Captured\n");
        expect(await lease.session.flush()).toMatchObject({
            ok: false,
            problem: { code: "internal" },
        });
        expect(lease.session.getSnapshot().recovery?.mutationId).toBe(mid);
        expect((await f.client.pendingWrites())[0]!.receipt.mutation).toBe(mid);
        f.replica.confirmAll();
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it.each(["receipt", "response"])("resolves a concurrent CAS conflict after capture (%s), including release/reopen", async (answer) => {
        const f = await fixture();
        let lease = await f.client.records.open(f.record.id);
        const original = f.client.update.bind(f.client);
        const update = vi.spyOn(f.client, "update").mockImplementationOnce(async (...args) => {
            expect(lease.session.getSnapshot().recovery).not.toBeNull();
            f.replica.editElsewhere(f.record.id, { body: "Theirs\n" });
            // MemoryReplica's CAS planner returns a rejected receipt, as does
            // the native planner. Also exercise a submit-level refusal.
            if (answer === "response")
                f.replica.failNextWrite(mdbaseError("conflict", "revision changed", "revision").toProblem());
            return original(...args);
        });
        lease.session.setBody("Mine\n");
        lease.session.patchFrontmatter({ title: "Mine" });
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code: "conflict" } });
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "conflict", body: "Mine\n", frontmatter: { title: "Mine" },
            dirty: true, recovery: null, remote: { body: "Theirs\n" },
        });
        lease.release();
        lease = await f.client.records.open(f.record.id);
        expect(lease.session.getSnapshot()).toMatchObject({ state: "conflict", recovery: null, dirty: true });
        lease.session.resolve({ keep: "mine" });
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "saved", body: "Mine\n", frontmatter: { title: "Mine" }, dirty: false });
        expect(update).toHaveBeenCalledTimes(2);
        lease.release();
    });
    it.each(["invalid_record", "forbidden"] as const)("keeps a refused %s draft editable across release/reopen and permits a deliberate save", async (code) => {
        const f = await fixture();
        let lease = await f.client.records.open(f.record.id);
        const update = vi.spyOn(f.client, "update"),
            receipt = vi.spyOn(f.client, "awaitReceipt");
        lease.session.setBody("Unsent\n");
        lease.session.patchFrontmatter({ title: "Invalid" });
        // The kit has no schema-validation planner; inject the native refusal
        // at the submit boundary, without fabricating a session/client error.
        f.replica.failNextWrite(mdbaseError(code, "write refused").toProblem());
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code } });
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "error", body: "Unsent\n", frontmatter: { title: "Invalid" }, dirty: true, recovery: null,
        });
        expect(receipt).not.toHaveBeenCalled();
        expect((await f.client.get(f.record.id, { include: { body: true } })).body).toBe("Original body\n");
        lease.release();
        lease = await f.client.records.open(f.record.id);
        expect(lease.session.getSnapshot()).toMatchObject({ body: "Unsent\n", frontmatter: { title: "Invalid" }, dirty: true, recovery: null });
        lease.session.patchFrontmatter({ title: "Fixed" });
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "saved", body: "Unsent\n", frontmatter: { title: "Fixed" }, dirty: false, recovery: null });
        expect(update).toHaveBeenCalledTimes(2);
        expect(update.mock.calls[1]![2]!.mutationId).not.toBe(update.mock.calls[0]![2]!.mutationId);
        lease.release();
    });
    it("classifies a submit-level not_found as deleted without losing the draft", async () => {
        const f = await fixture(), lease = await f.client.records.open(f.record.id);
        lease.session.setBody("Unsent\n");
        f.replica.failNextWrite(mdbaseError("not_found", "record deleted").toProblem());
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code: "not_found" } });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "deleted", dirty: true, body: "Unsent\n", recovery: null });
        lease.release();
    });
    it("clears capture on the client's local view-only refusal", async () => {
        const f = await fixture(false, "viewer"), lease = await f.client.records.open(f.record.id);
        lease.session.setBody("Unsent\n");
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code: "forbidden", reason: "read_only" } });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "error", dirty: true, body: "Unsent\n", recovery: null });
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code: "forbidden", reason: "read_only" } });
        lease.release();
    });
    it.each(["outcome_unknown", "unavailable", "cancelled", "internal"] as const)("retains a captured mutation after an ambiguous %s response and settles it after reopen", async (code) => {
        const f = await fixture(true);
        let lease = await f.client.records.open(f.record.id);
        const original = f.client.update.bind(f.client);
        const update = vi.spyOn(f.client, "update").mockImplementationOnce(async (...args) => {
            const write = await original(...args);
            // A later submit of the same MID gets an uncertain response even
            // though the first request really captured it.
            f.replica.failNextWrite(mdbaseError(code, "capture uncertain").toProblem());
            await original(...args);
            return write;
        });
        lease.session.setBody("Captured\n");
        expect(await lease.session.flush()).toMatchObject({ ok: false, problem: { code } });
        const mid = lease.session.getSnapshot().recovery!.mutationId;
        expect(lease.session.getSnapshot()).toMatchObject({ state: "recovery", dirty: true });
        lease.release();
        lease = await f.client.records.open(f.record.id);
        expect(lease.session.getSnapshot().recovery!.mutationId).toBe(mid);
        f.replica.confirmAll();
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        expect(lease.session.getSnapshot()).toMatchObject({ state: "saved", body: "Captured\n", recovery: null, dirty: false });
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it("re-settles a write left in recovery once its confirmation arrives, without another flush", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id, { autosave: false }),
            original = f.client.update.bind(f.client);
        const update = vi
            .spyOn(f.client, "update")
            .mockImplementation(async (target, input, options) => {
                await original(target, input, options);
                throw new MdbaseError({
                    code: "unavailable",
                    recovery: "retry",
                    message: "reply lost",
                });
            });
        lease.session.setBody("Captured\n");
        expect(await lease.session.flush()).toMatchObject({ ok: false });
        expect(lease.session.getSnapshot().state).toBe("recovery");
        f.replica.confirmAll();
        await vi.waitFor(() =>
            expect(lease.session.getSnapshot()).toMatchObject({
                state: "saved",
                body: "Captured\n",
                recovery: null,
                problem: null,
            }),
        );
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it("preserves later body/frontmatter reversions while an earlier intent is pending", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id),
            update = vi.spyOn(f.client, "update");
        lease.session.setBody("First\n");
        lease.session.patchFrontmatter({ title: "First" });
        const flush = lease.session.flush();
        await untilCaptured(lease);
        await vi.waitFor(async () =>
            expect((await f.client.pendingWrites()).length).toBe(1),
        );
        lease.session.setBody("Original body\n");
        lease.session.patchFrontmatter({ title: "Original" });
        f.replica.confirmAll();
        await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        f.replica.confirmAll();
        expect(await flush).toMatchObject({ ok: true });
        expect(lease.session.getSnapshot()).toMatchObject({
            body: "Original body\n",
            dirty: false,
        });
        expect(lease.session.getSnapshot().frontmatter.title).toBe(
            "Original",
        );
        lease.release();
    });
    it("refuses metadata-only/mismatched source before open or submit", async () => {
        const f = await fixture(),
            row = await f.client.get(f.record.id, { include: { body: true } }),
            get = vi.spyOn(f.client, "get").mockResolvedValue(row),
            update = vi.spyOn(f.client, "update");
        await expect(f.client.records.open(f.record.id)).rejects.toMatchObject({
            code: "invalid_request",
        });
        get.mockResolvedValue({ ...row, document: "not the original source" });
        await expect(f.client.records.open(f.record.id)).rejects.toMatchObject({
            code: "invalid_request",
        });
        expect(update).not.toHaveBeenCalled();
    });
    it("refuses native protection and pending current records without minting an update", async () => {
        const f = await fixture(),
            row = await f.client.get(f.record.id, {
                include: { body: true, document: true },
            });
        vi.spyOn(f.client, "get").mockResolvedValue({
            ...row,
            state: { ...row.state, unresolved: 1 },
        });
        const lease = await f.client.records.open(f.record.id),
            update = vi.spyOn(f.client, "update");
        lease.session.setBody("mine");
        expect(await lease.session.flush()).toMatchObject({
            ok: false,
            problem: { code: "conflict" },
        });
        expect(update).not.toHaveBeenCalled();
        expect(() => lease.session.resolve({ keep: "mine" })).toThrow();
        lease.release();
    });
    it("does not publish an applied receipt followed by another genuine pending current readback", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id),
            original = f.client.awaitReceipt.bind(f.client);
        const receipt = vi
            .spyOn(f.client, "awaitReceipt")
            .mockImplementation(async (mid, o) => {
                f.replica.confirmAll();
                const r = await original(mid, o);
                const seen = await f.client.get(f.record.id, {
                    include: { body: true, document: true },
                });
                await f.client.update(seen, {
                    body: "other pending\n",
                    ifRevision: seen.revision,
                });
                return r;
            });
        lease.session.setBody("first\n");
        expect(await lease.session.flush()).toMatchObject({
            ok: false,
            problem: { reason: "unqualified_readback" },
        });
        expect(lease.session.getSnapshot().recovery).not.toBeNull();
        receipt.mockRestore();
        f.replica.confirmAll();
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        lease.release();
    });
    it("requires explicit current-source conflict resolution, never a blind fresh revision", async () => {
        const f = await fixture(),
            lease = await f.client.records.open(f.record.id);
        lease.session.setBody("mine");
        const current = await f.client.get(f.record.id, {
                include: { body: true, document: true },
            }),
            w = await f.client.update(current, { body: "theirs" });
        await w.confirmed;
        expect(await lease.session.flush()).toMatchObject({
            ok: false,
            problem: { code: "conflict" },
        });
        expect(lease.session.getSnapshot().body).toBe("mine");
        lease.session.resolve({ keep: "mine" });
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        expect(lease.session.getSnapshot().body).toBe("mine");
        lease.release();
    });
    it("cancels one lease without cancelling a peer's draft or closing the client", async () => {
        const f = await fixture(),
            controller = new AbortController(),
            a = await f.client.records.open(f.record.id, {
                signal: controller.signal,
            }),
            b = await f.client.records.open(f.record.id);
        a.session.setBody("peer draft");
        controller.abort();
        expect(() => a.session.setBody("bad")).toThrow();
        expect(b.session.getSnapshot().body).toBe("peer draft");
        expect(await b.session.flush()).toMatchObject({ ok: true });
        b.release();
    });
    it("keeps getSnapshot stable and public native maps isolated from the actual base", async () => {
        const f = await fixture(),
            lease = await f.client.records.open(f.record.id),
            snap = lease.session.getSnapshot();
        expect(lease.session.getSnapshot()).toBe(snap);
        snap.record.frontmatter.title = "tampered";
        snap.frontmatter.title = "tampered";
        lease.session.setBody("changed");
        expect(lease.session.getSnapshot().frontmatter.title).toBe(
            "Original",
        );
        lease.release();
    });
    it("opens an earlier session's pending write as saved on device and edits on top of it", async () => {
        const f = await fixture(true),
            seen = await f.client.get(f.record.id, {
                include: { body: true, document: true },
            });
        const other = await f.client.update(seen, {
            body: "other session",
            ifRevision: seen.revision,
        });
        const next = await connect({
            connector: f.replica.connector(),
            app: { name: "writer-test", version: "test" },
            reconnect: false,
        });
        clients.push(next);
        const lease = await next.records.open(f.record.id, { autosave: false });
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "saved_on_device",
            body: "other session",
            recovery: null,
        });
        await vi.waitFor(() =>
            expect(next.ledger.getSnapshot().pending.map((e) => e.mutationId)).toEqual([other.mutationId]),
        );
        const layered = lease.session.getSnapshot().record.revision;
        const update = vi.spyOn(next, "update");
        lease.session.setBody("on top\n");
        const flushing = lease.session.flush();
        await vi.waitFor(() => expect(lease.session.getSnapshot().recovery?.write).toBeTruthy());
        f.replica.confirmAll();
        expect(await flushing).toMatchObject({ ok: true });
        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0]![1]).toMatchObject({ ifRevision: layered, body: "on top\n" });
        lease.release();
    });
    it("refuses a genuine receipt for another record supplied through a recovery hint", async () => {
        const f = await fixture(),
            other = f.replica.seed({ path: "notes/other.md", body: "other" });
        const seen = await f.client.get(other.id, {
                include: { body: true, document: true },
            }),
            write = await f.client.update(seen, {
                body: "other updated",
                ifRevision: seen.revision,
            });
        await write.confirmed;
        const update = vi.spyOn(f.client, "update"),
            lease = await f.client.records.open(f.record.id, {
                recovery: {
                    mutationId: write.mutationId,
                    recordId: f.record.id,
                    baseRevision: seen.revision,
                },
            });
        expect(await lease.session.flush()).toMatchObject({
            ok: false,
            problem: { reason: "receipt_record_witness_required" },
        });
        expect(lease.session.getSnapshot().recovery?.mutationId).toBe(
            write.mutationId,
        );
        expect(update).not.toHaveBeenCalled();
        lease.release();
    });
    it("autosaves only when explicitly configured and stops delivery on release", async () => {
        const f = await fixture(),
            update = vi.spyOn(f.client, "update"),
            lease = await f.client.records.open(f.record.id, {
                autosave: { idleMs: 5 },
            });
        lease.session.setBody("autosaved");
        await vi.waitFor(() =>
            expect(lease.session.getSnapshot()).toMatchObject({
                state: "saved",
                body: "autosaved",
                dirty: false,
            }),
        );
        expect(update).toHaveBeenCalledTimes(1);
        lease.session.setBody("retained unsent");
        lease.release();
        await new Promise((r) => setTimeout(r, 20));
        expect(update).toHaveBeenCalledTimes(1);
    });
    it("a cancelled second flush waiter cannot cancel the original capture", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id);
        lease.session.setBody("one");
        const first = lease.session.flush();
        await untilCaptured(lease);
        const controller = new AbortController(),
            second = lease.session.flush({ signal: controller.signal });
        controller.abort();
        await expect(second).rejects.toMatchObject({ code: "cancelled" });
        f.replica.confirmAll();
        expect(await first).toMatchObject({ ok: true });
        lease.release();
    });
    it.each([NaN])(
        "validates a peer timeout %s without touching the original drive",
        async (duration) => {
            const f = await fixture(true),
                a = await f.client.records.open(f.record.id),
                b = await f.client.records.open(f.record.id),
                update = vi.spyOn(f.client, "update");
            a.session.setBody("original pending draft");
            const first = a.session.flush({ timeoutMs: 1000 }),
                mid = await untilCaptured(a);
            expect(() => b.session.flush({ timeoutMs: duration })).toThrow(
                expect.objectContaining({
                    code: "invalid_request",
                    reason: "invalid_timeout",
                }),
            );
            expect(a.session.getSnapshot().recovery?.mutationId).toBe(mid);
            expect(a.session.getSnapshot().body).toBe("original pending draft");
            await vi.waitFor(async () =>
                expect((await f.client.pendingWrites()).length).toBe(1),
            );
            f.replica.confirmAll();
            expect(await first).toMatchObject({ ok: true });
            expect(update).toHaveBeenCalledTimes(1);
            a.release();
            b.release();
        },
    );
    // Regression: two separate leases, original 1000ms versus peer 10ms.
    it("bounds a peer lease flush wait without cancelling its original owner", async () => {
        const f = await fixture(true),
            a = await f.client.records.open(f.record.id),
            b = await f.client.records.open(f.record.id),
            owner = new AbortController(),
            update = vi.spyOn(f.client, "update");
        a.session.setBody("original pending draft");
        const first = a.session.flush({
                timeoutMs: 1000,
                signal: owner.signal,
            }),
            mid = await untilCaptured(a);
        await vi.waitFor(async () =>
            expect((await f.client.pendingWrites()).length).toBe(1),
        );
        const second = b.session.flush({ timeoutMs: 10 });
        const outcome = await Promise.race([
            second.then(
                () => "settled",
                () => "settled",
            ),
            new Promise<string>((r) =>
                setTimeout(() => r("still waiting"), 100),
            ),
        ]);
        const originalStillOwned = a.session.getSnapshot().recovery?.mutationId;
        // Unlike a timeout on the waiter, explicit owner cancellation may stop its own drive.
        owner.abort();
        expect(await first).toMatchObject({ ok: false });
        a.release();
        b.release();
        expect(originalStillOwned).toBe(mid);
        expect(update).toHaveBeenCalledTimes(1);
        expect(outcome).toBe("settled");
    });
    it("refuses a mismatching receipt without changing or replacing the original MID", async () => {
        const f = await fixture(true),
            lease = await f.client.records.open(f.record.id),
            update = vi.spyOn(f.client, "update");
        vi.spyOn(f.client, "awaitReceipt").mockResolvedValue({
            mutation: crypto.randomUUID(),
            state: "confirmed",
        });
        lease.session.setBody("mine");
        expect(await lease.session.flush()).toMatchObject({
            ok: false,
            problem: { reason: "mutation_identity_mismatch" },
        });
        expect(lease.session.getSnapshot().recovery).not.toBeNull();
        expect(update).toHaveBeenCalledTimes(1);
        lease.release();
    });
    it("isolates late read replies after aborted open and captures UUID selection before queueing", async () => {
        const f = await fixture(),
            controller = new AbortController(),
            row = await f.client.get(f.record.id, {
                include: { body: true, document: true },
            });
        vi.spyOn(f.client, "get").mockImplementation(async () => {
            controller.abort();
            return row;
        });
        await expect(
            f.client.records.open(f.record.id, { signal: controller.signal }),
        ).rejects.toHaveProperty("name", "AbortError");
    });
    it("bounds retained session count without discarding the first draft", async () => {
        const f = await fixture(),
            first = await f.client.records.open(f.record.id);
        first.session.setBody("keep me");
        first.release();
        for (let i = 1; i < 64; i++) {
            const row = f.replica.seed({
                path: `notes/retained-${i}.md`,
                body: "original",
            });
            const lease = await f.client.records.open(row.id);
            lease.session.setBody("retained");
            lease.release();
        }
        const extra = f.replica.seed({
            path: "notes/overflow.md",
            body: "original",
        });
        await expect(f.client.records.open(extra.id)).rejects.toMatchObject({
            reason: "record_session_budget",
        });
        const again = await f.client.records.open(f.record.id);
        expect(again.session.getSnapshot().body).toBe("keep me");
        again.release();
    });
    it("bounds draft retention without evicting original work", async () => {
        const f = await fixture(),
            lease = await f.client.records.open(f.record.id);
        lease.session.setBody("safe draft");
        expect(() =>
            lease.session.setBody("x".repeat(8 * 1024 * 1024 + 1)),
        ).toThrow();
        expect(lease.session.getSnapshot().body).toBe("safe draft");
        lease.release();
    });
});
