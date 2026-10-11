// Real SDK over MemoryReplica: protocol/lease grammar, not native/LAB qualification.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    connect,
    MdbaseError,
    type MdbaseClient,
    type RecordLease,
} from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
const clients: MdbaseClient[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.restoreAllMocks();
});
async function fixture(pending = false) {
    const replica = new MemoryReplica({ confirmDelayMs: pending ? null : 0 });
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
    it("does not turn pending receipts into saved and recovers exactly the same MID without submit", async () => {
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
            ok: false,
            problem: { code: "outcome_unknown" },
        });
        const mutation = lease.session.getSnapshot().recovery!.mutationId;
        expect(lease.session.getSnapshot().state).toBe("recovery");
        expect((await f.client.pendingWrites())[0]!.receipt.mutation).toBe(
            mutation,
        );
        expect(await lease.session.flush()).toMatchObject({ ok: false });
        expect(update).toHaveBeenCalledTimes(1);
        receipt.mockRestore();
        f.replica.confirmAll();
        expect(await lease.session.flush()).toMatchObject({ ok: true });
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
        expect(lease.session.getSnapshot().frontmatter.get("title")).toBe(
            "Original",
        );
        lease.release();
    });
    it("refuses metadata-only/mismatched source before open or submit", async () => {
        const f = await fixture(),
            row = await f.client.get(f.record.id, { body: true }),
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
                body: true,
                document: true,
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
            .mockImplementation(async (mid, ms, signal) => {
                f.replica.confirmAll();
                const r = await original(mid, ms, signal);
                const seen = await f.client.get(f.record.id, {
                    body: true,
                    document: true,
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
                body: true,
                document: true,
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
        snap.record.frontmatter.set("title", "tampered");
        lease.session.setBody("changed");
        expect(lease.session.getSnapshot().frontmatter.get("title")).toBe(
            "Original",
        );
        lease.release();
    });
    it("recovers this SDK client's one exact native pending operation without another submit", async () => {
        const f = await fixture(true),
            seen = await f.client.get(f.record.id, {
                body: true,
                document: true,
            }),
            write = await f.client.update(seen, {
                body: "before editor open",
                ifRevision: seen.revision,
            });
        const update = vi.spyOn(f.client, "update"),
            lease = await f.client.records.open(f.record.id);
        expect(lease.session.getSnapshot().recovery).toMatchObject({
            mutationId: write.mutationId,
            recordId: f.record.id,
            baseRevision: seen.revision,
            write: null,
        });
        f.replica.confirmAll();
        expect(await lease.session.flush()).toMatchObject({ ok: true });
        expect(update).not.toHaveBeenCalled();
        lease.release();
    });
    it("recovers, without resubmitting, the owner's pending write in a new session", async () => {
        const f = await fixture(true),
            seen = await f.client.get(f.record.id, {
                body: true,
                document: true,
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
        // Pending writes are owner-scoped, as on the replica: a reload sees them.
        expect((await next.pendingWrites()).map((p) => p.receipt.mutation)).toEqual([other.mutationId]);
        const update = vi.spyOn(next, "update"),
            lease = await next.records.open(f.record.id);
        expect(lease.session.getSnapshot()).toMatchObject({
            state: "recovery",
            recovery: { mutationId: other.mutationId, recordId: f.record.id },
        });
        f.replica.confirmAll();
        await lease.session.flush();
        expect(update).not.toHaveBeenCalled();
        lease.release();
    });
    it("refuses a genuine receipt for another record supplied through a recovery hint", async () => {
        const f = await fixture(),
            other = f.replica.seed({ path: "notes/other.md", body: "other" });
        const seen = await f.client.get(other.id, {
                body: true,
                document: true,
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
                body: true,
                document: true,
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
