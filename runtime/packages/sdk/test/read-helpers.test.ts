// Public SDK over MemoryReplica / controlled read replies: helper grammar only,
// not native snapshot, cursor, authorization or app/browser qualification.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    connect,
    READ_MANY_MAX_REFS,
    MdbaseError,
    type MdbaseClient,
    type RecordRef,
} from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
const clients: MdbaseClient[] = [];
afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    vi.restoreAllMocks();
});
async function fixture() {
    const replica = new MemoryReplica();
    const a = replica.seed({
            path: "notes/one.md",
            body: "One\n",
            frontmatter: { title: "One" },
        }),
        b = replica.seed({
            path: "notes/two.md",
            body: "Two\n",
            frontmatter: { title: "Two" },
        });
    const client = await connect({
        connector: replica.connector(),
        app: { name: "read-helpers-test", version: "test" },
        reconnect: false,
    });
    clients.push(client);
    return { replica, client, a, b };
}
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
        release = r;
    });
    return { promise, release };
}
describe("readMany ordered bounded ordinary gets", () => {
    it("preserves genuine IDs, order and duplicates for UUID/path/view refs and explicit Include", async () => {
        const f = await fixture(),
            seen = await f.client.get(f.a.id),
            get = vi.spyOn(f.client, "get"),
            signal = new AbortController().signal;
        const rows = await f.client.readMany(
            [f.b.id, { path: f.a.path }, seen, f.b.id],
            { body: true, document: true, effective: true },
            signal,
            { concurrency: 2 },
        );
        expect(rows.map((r) => r.id)).toEqual([f.b.id, f.a.id, f.a.id, f.b.id]);
        expect(rows.map((r) => r.body)).toEqual([
            "Two\n",
            "One\n",
            "One\n",
            "Two\n",
        ]);
        expect(rows.every((r) => typeof r.document === "string")).toBe(true);
        expect(get).toHaveBeenCalledTimes(4);
        expect(get.mock.calls.map((c) => c[2])).toEqual([
            signal,
            signal,
            signal,
            signal,
        ]);
    });
    it("bounds dispatch even when replies finish out of order", async () => {
        const f = await fixture(),
            original = f.client.get.bind(f.client),
            gates = Array.from({ length: 4 }, gate);
        let active = 0,
            max = 0,
            index = 0;
        const get = vi
            .spyOn(f.client, "get")
            .mockImplementation(async (ref, include, signal) => {
                const i = index++;
                active++;
                max = Math.max(max, active);
                try {
                    const row = await original(ref, include, signal);
                    await gates[i]!.promise;
                    return row;
                } finally {
                    active--;
                }
            });
        const batch = f.client.readMany(
            [f.a.id, f.b.id, f.a.id, f.b.id],
            undefined,
            undefined,
            { concurrency: 2 },
        );
        expect(get).toHaveBeenCalledTimes(2);
        gates[1]!.release();
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
        gates[2]!.release();
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
        gates[3]!.release();
        gates[0]!.release();
        expect((await batch).map((r) => r.id)).toEqual([
            f.a.id,
            f.b.id,
            f.a.id,
            f.b.id,
        ]);
        expect(max).toBe(2);
    });
    it("stops scheduling on actual missing failure and settles started calls before rejecting the original error", async () => {
        const f = await fixture(),
            original = f.client.get.bind(f.client),
            slow = gate();
        let missing: unknown;
        try {
            await original({ path: "missing.md" });
        } catch (e) {
            missing = e;
        }
        expect(missing).toBeInstanceOf(MdbaseError);
        const get = vi
            .spyOn(f.client, "get")
            .mockImplementation(async (ref, include, signal) => {
                if (
                    typeof ref === "object" &&
                    "path" in ref &&
                    ref.path === "missing.md"
                )
                    throw missing;
                const row = await original(ref, include, signal);
                await slow.promise;
                return row;
            });
        const batch = f.client.readMany(
            [{ path: "missing.md" }, f.a.id, f.b.id],
            undefined,
            undefined,
            { concurrency: 2 },
        );
        let settled = false;
        void batch.catch(() => {
            settled = true;
        });
        await new Promise((r) => setTimeout(r, 5));
        expect(get).toHaveBeenCalledTimes(2);
        expect(settled).toBe(false);
        slow.release();
        await expect(batch).rejects.toBe(missing);
        expect(get).toHaveBeenCalledTimes(2);
    });
    it.each([0])(
        "validates concurrency %s before any get",
        async (concurrency) => {
            const f = await fixture(),
                get = vi.spyOn(f.client, "get");
            await expect(
                f.client.readMany([f.a.id], undefined, undefined, {
                    concurrency,
                }),
            ).rejects.toMatchObject({
                code: "invalid_request",
                reason: "read_many_bounds",
            });
            expect(get).not.toHaveBeenCalled();
        },
    );
    it("validates count and every selector before any dispatch", async () => {
        const f = await fixture(),
            get = vi.spyOn(f.client, "get");
        await expect(
            f.client.readMany(Array(READ_MANY_MAX_REFS + 1).fill(f.a.id)),
        ).rejects.toMatchObject({ reason: "read_many_bounds" });
        await expect(
            f.client.readMany([f.a.id, { path: "x".repeat(4097) }]),
        ).rejects.toMatchObject({ reason: "read_many_bounds" });
        await expect(
            f.client.readMany([f.a.id, { path: "é".repeat(2049) }]),
        ).rejects.toMatchObject({ reason: "read_many_bounds" });
        await expect(
            f.client.readMany(new Array<RecordRef>(1)),
        ).rejects.toMatchObject({ reason: "read_many_selection" });
        expect(get).not.toHaveBeenCalled();
    });
    it("empty reads are empty, but pre-aborted empty reads cannot deliver success", async () => {
        const f = await fixture(),
            get = vi.spyOn(f.client, "get");
        expect(await f.client.readMany([])).toEqual([]);
        await expect(
            f.client.readMany([], undefined, AbortSignal.abort()),
        ).rejects.toHaveProperty("name", "AbortError");
        expect(get).not.toHaveBeenCalled();
    });
    it("fences cancellation after a backend late reply, preserving original signal and dispatch count", async () => {
        const f = await fixture(),
            row = await f.client.get(f.a.id),
            slow = gate(),
            controller = new AbortController();
        const get = vi.spyOn(f.client, "get").mockImplementation(async () => {
            await slow.promise;
            return row;
        });
        const batch = f.client.readMany(
            [f.a.id, f.a.id],
            undefined,
            controller.signal,
            { concurrency: 1 },
        );
        controller.abort();
        slow.release();
        await expect(batch).rejects.toHaveProperty("name", "AbortError");
        expect(get).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0]![2]).toBe(controller.signal);
    });
    it("binds selected UUIDs to genuine readback without substituting another record", async () => {
        const f = await fixture(),
            wrong = await f.client.get(f.b.id),
            get = vi.spyOn(f.client, "get").mockResolvedValue(wrong);
        await expect(
            f.client.readMany([f.a.id, f.a.id], undefined, undefined, {
                concurrency: 1,
            }),
        ).rejects.toMatchObject({ reason: "read_many_identity_mismatch" });
        expect(get).toHaveBeenCalledTimes(1);
    });
});
