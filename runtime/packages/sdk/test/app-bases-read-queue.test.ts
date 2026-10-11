// Actual local-facade/MessageChannel with a controlled wire peer; not native
// Bases, browser/LAB, physical drain, owner lease or durability acceptance.
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import {
    appLocalConnector,
    type AppLocalScope,
} from "../src/app-host/local-facade.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture(isCurrent = () => true) {
    const scope: AppLocalScope = {
        account: "11111111-1111-4111-8111-111111111111",
        installation: "22222222-2222-4222-8222-222222222222",
        collection: "33333333-3333-4333-8333-333333333333",
        isCurrent,
    };
    const binding = JSON.stringify([
        scope.account,
        scope.installation,
        scope.collection,
    ]);
    const { port1: host, port2: ui } = new MessageChannel();
    const received: { kind: string; id: number; bytes: Uint8Array }[] = [];
    host.on("message", (packet: unknown[]) => {
        if (packet[2] === "frame") host.postMessage(packet);
        else if (typeof packet[2] === "string" && packet[2].endsWith("request"))
            received.push({
                kind: packet[2],
                id: packet[3] as number,
                bytes: packet[4] as Uint8Array,
            });
    });
    const connector = appLocalConnector(ui as unknown as MessagePort, scope);
    cleanups.push(() => {
        connector.close();
        host.close();
        ui.close();
    });
    const { port } = await connector.open([0]);
    return {
        port,
        connector,
        received,
        reply(index: number) {
            const item = received[index]!;
            host.postMessage([
                1,
                binding,
                item.kind.replace("request", "response"),
                item.id,
                Uint8Array.of(item.bytes[0]!),
            ]);
        },
    };
}
it("overlapping execution/discovery/source reads queue and dispatch FIFO on the original channel", async () => {
    const f = await fixture();
    const first = f.port.readAppBases!(Uint8Array.of(1));
    const second = f.port.readAppBasesDiscovery!(
        "list-views",
        Uint8Array.of(2),
    );
    const third = f.port.readAppBasesDiscovery!(
        "read-view-source",
        Uint8Array.of(3),
    );
    // Observe rejections immediately even on the original RED guard.
    const all = Promise.allSettled([first, second, third]);
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.reply(0);
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.reply(1);
    await vi.waitFor(() => expect(f.received).toHaveLength(3));
    f.reply(2);
    expect(await all).toEqual(
        [1, 2, 3].map((value) => ({
            status: "fulfilled",
            value: Uint8Array.of(value),
        })),
    );
    expect(f.received.map((item) => item.kind)).toEqual([
        "bases-request",
        "bases-list-views-request",
        "bases-read-view-source-request",
    ]);
    expect(f.received.map((item) => item.id)).toEqual([1, 2, 3]);
});
it("abort while queued removes only that waiter, never sends it, and preserves FIFO", async () => {
    const f = await fixture(),
        abort = new AbortController();
    const first = f.port.readAppBases!(Uint8Array.of(1));
    const second = f.port.readAppBases!(Uint8Array.of(2), abort.signal);
    const third = f.port.readAppBases!(Uint8Array.of(3));
    const all = Promise.allSettled([first, second, third]);
    abort.abort();
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.reply(0);
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    expect(f.received[1]?.bytes).toEqual(Uint8Array.of(3));
    f.reply(1);
    const results = await all;
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[2]?.status).toBe("fulfilled");
});
it("cancelling active delivery retains the occupied slot until its original reply", async () => {
    const f = await fixture(),
        abort = new AbortController();
    const first = f.port.readAppBases!(Uint8Array.of(1), abort.signal);
    const second = f.port.readAppBases!(Uint8Array.of(2));
    const all = Promise.allSettled([first, second]);
    abort.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.received).toHaveLength(1);
    f.reply(0);
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.reply(1);
    expect((await all)[1]).toEqual({
        status: "fulfilled",
        value: Uint8Array.of(2),
    });
});
it("close settles active and all queued reads with typed cancelled without dispatching waiters", async () => {
    const f = await fixture();
    const reads = [
        f.port.readAppBases!(Uint8Array.of(1)),
        f.port.readAppBasesDiscovery!("list-views", Uint8Array.of(2)),
        f.port.readAppBasesDiscovery!("read-view-source", Uint8Array.of(3)),
    ];
    const all = Promise.allSettled(reads);
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.connector.close();
    expect(
        (await all).every(
            (item) =>
                item.status === "rejected" && item.reason.code === "cancelled",
        ),
    ).toBe(true);
    expect(f.received).toHaveLength(1);
});
it("bounds the waiting queue at 32, uses unavailable backpressure, and admits again after queued abort", async () => {
    const f = await fixture(),
        abort = new AbortController();
    const first = f.port.readAppBases!(Uint8Array.of(1));
    const waiters = Array.from({ length: 32 }, (_, i) =>
        f.port.readAppBases!(
            Uint8Array.of(i + 2),
            i === 0 ? abort.signal : undefined,
        ),
    );
    const all = Promise.allSettled([first, ...waiters]);
    await expect(f.port.readAppBases!(Uint8Array.of(99))).rejects.toMatchObject(
        { code: "unavailable", reason: "bases_read_backpressure" },
    );
    abort.abort();
    await expect(waiters[0]).rejects.toMatchObject({ code: "cancelled" });
    const admitted = f.port.readAppBases!(Uint8Array.of(100));
    const observed = Promise.allSettled([admitted]);
    f.connector.close();
    await all;
    expect((await observed)[0]).toMatchObject({
        status: "rejected",
        reason: { code: "cancelled" },
    });
});
it.each([2, 3])(
    "source-triggered abort at currentness cut %s does not send wiped input or abandon an occupied slot",
    async (cut) => {
        const abort = new AbortController();
        let enabled = false,
            checks = 0;
        const f = await fixture(() => {
            if (enabled && ++checks === cut) abort.abort();
            return true;
        });
        enabled = true;
        const first = f.port.readAppBases!(Uint8Array.of(7), abort.signal);
        await expect(first).rejects.toMatchObject({ code: "cancelled" });
        enabled = false;
        const second = f.port.readAppBases!(Uint8Array.of(8));
        const all = Promise.allSettled([second]);
        await vi.waitFor(() => expect(f.received).toHaveLength(1));
        expect(f.received[0]?.bytes).toEqual(Uint8Array.of(cut === 2 ? 8 : 7));
        f.reply(0);
        if (cut === 3) {
            await vi.waitFor(() => expect(f.received).toHaveLength(2));
            expect(f.received[1]?.bytes).toEqual(Uint8Array.of(8));
            f.reply(1);
        }
        expect((await all)[0]).toEqual({
            status: "fulfilled",
            value: Uint8Array.of(8),
        });
    },
);
it("currentness loss closes the original channel and cancels the queue without publishing or dispatching later reads", async () => {
    let current = true;
    const f = await fixture(() => current);
    const first = f.port.readAppBases!(Uint8Array.of(1)),
        second = f.port.readAppBases!(Uint8Array.of(2));
    const all = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    current = false;
    f.reply(0);
    expect(
        (await all).every(
            (item) =>
                item.status === "rejected" && item.reason.code === "cancelled",
        ),
    ).toBe(true);
    expect(f.received).toHaveLength(1);
});
it("captures queued bytes before await and preserves request bounds/pre-aborted no-dispatch", async () => {
    const f = await fixture(),
        borrowed = Uint8Array.of(7);
    const first = f.port.readAppBases!(Uint8Array.of(1));
    const second = f.port.readAppBases!(borrowed);
    const all = Promise.allSettled([first, second]);
    borrowed.fill(0);
    await expect(
        f.port.readAppBases!(new Uint8Array(128 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
        f.port.readAppBases!(Uint8Array.of(3), AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.reply(0);
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    expect(f.received[1]?.bytes).toEqual(Uint8Array.of(7));
    f.reply(1);
    expect((await all)[1]).toEqual({
        status: "fulfilled",
        value: Uint8Array.of(7),
    });
});
