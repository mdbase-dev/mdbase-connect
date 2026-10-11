// Real TimersApi with controlled READ replies; scoped facet tests, not a
// criteria/delivery producer, browser permission or registration acceptance.
import { MDBASE_TIMER_FIRED_CONTRACT, type ApplicationNotifications } from "@mdbase-dev/connect-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { TimersApi, type AppTimersPort } from "../src/timers.js";
import {
    createApplicationNotificationReadiness,
    type ApplicationNotificationReadinessOptions,
} from "../src/application/notification-readiness.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const close of cleanup.splice(0).reverse()) close();
});
const declaration: ApplicationNotifications = {
    criteria: [
        {
            id: "reminder",
            event: {
                id: "acme.task",
                version: "1.0.0",
                digest: `sha256:${"11".repeat(32)}`,
            },
            presentation: { title: "Reminder" },
        },
    ],
};
function fixture() {
    const write = vi.fn(async () => {
            throw Error("test must never write");
        }),
        borrowedClose = vi.fn();
    const list = vi.fn(
        async (
            namespace: string,
            _options: Parameters<AppTimersPort["list"]>[1],
        ) => ({ namespace, timers: [] }),
    );
    const port: AppTimersPort = {
        list,
        put: write,
        cancel: write,
        reconcile: write,
        registerWebPush: write,
        unregisterWebPush: write,
        registerFcm: write,
        unregisterFcm: write,
        close: borrowedClose,
    };
    const timers = new TimersApi(port),
        lifetime = new AbortController();
    let current = true;
    const options: ApplicationNotificationReadinessOptions = {
        notifications: { declaration, timerNamespace: "fixture.reminders" },
        timers,
        scope: {
            account: "11111111-1111-4111-8111-111111111111",
            installation: "22222222-2222-4222-8222-222222222222",
            collection: "33333333-3333-4333-8333-333333333333",
        },
        generation: "fixture-generation",
        signal: lifetime.signal,
        isCurrent: () => current,
    };
    const create = () => {
        const facet = createApplicationNotificationReadiness(options);
        cleanup.push(facet.close);
        return facet;
    };
    return {
        options,
        create,
        list,
        write,
        borrowedClose,
        lifetime,
        change: () => {
            current = false;
        },
    };
}
it("freezes the facade/snapshot and explicit validated null is ready only for this facet, without IO", async () => {
    const f = fixture();
    const facet = createApplicationNotificationReadiness({
        ...f.options,
        notifications: { declaration: null },
    });
    cleanup.push(facet.close);
    expect(Object.isFrozen(facet)).toBe(true);
    expect(facet.getSnapshot().assessment).toBeNull();
    const result = await facet.start();
    expect(result.assessment?.status).toBe("ready");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assessment)).toBe(true);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    facet.close();
    expect(f.borrowedClose).not.toHaveBeenCalled();
});
it("missing declaration projection cannot become no requirements or READY", async () => {
    const f = fixture(),
        facet = createApplicationNotificationReadiness({
            ...f.options,
            notifications: undefined,
        });
    cleanup.push(facet.close);
    expect(await facet.start()).toMatchObject({
        assessment: null,
        problem: { code: "notifications_unsupported" },
    });
    expect(f.list).not.toHaveBeenCalled();
});
it("successful timer namespace access is not criteria/delivery readiness and never writes", async () => {
    const f = fixture(),
        facet = f.create(),
        observer = vi.fn();
    const stop = facet.subscribe(observer);
    const result = await facet.start();
    expect(result).toMatchObject({
        checking: false,
        assessment: null,
        problem: { code: "notifications_unsupported" },
    });
    expect(f.list).toHaveBeenCalledWith("fixture.reminders", {
        signal: expect.any(AbortSignal),
    });
    expect(f.list.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    expect(observer).toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    stop();
    observer.mockClear();
    await facet.refresh();
    expect(observer).not.toHaveBeenCalled();
});
it.each([undefined, "derived/from/scope"])(
    "missing/invalid namespace %s is unsupported without trying a READ",
    async (timerNamespace) => {
        const f = fixture(),
            facet = createApplicationNotificationReadiness({
                ...f.options,
                notifications: { declaration, timerNamespace },
            });
        cleanup.push(facet.close);
        expect(await facet.start()).toMatchObject({
            assessment: null,
            problem: { code: "notifications_unsupported" },
        });
        expect(f.list).not.toHaveBeenCalled();
    },
);
it("absent borrowed timer READ is unsupported rather than port-presence READY", async () => {
    const f = fixture(),
        facet = createApplicationNotificationReadiness({
            ...f.options,
            timers: undefined,
        });
    cleanup.push(facet.close);
    expect(await facet.start()).toMatchObject({
        assessment: null,
        problem: { code: "notifications_unsupported" },
    });
    expect(f.list).not.toHaveBeenCalled();
});
it("declared timer criteria without approved timers ask for consent", async () => {
    const f = fixture(),
        facet = createApplicationNotificationReadiness({
            ...f.options,
            notifications: {
                declaration: {
                    criteria: [{ ...declaration.criteria[0]!, event: MDBASE_TIMER_FIRED_CONTRACT }],
                },
            },
            timers: undefined,
        });
    cleanup.push(facet.close);
    expect(await facet.start()).toMatchObject({
        assessment: null,
        problem: { code: "notifications_consent_required" },
    });
});
it("failed READ clears assessment and exposes only bounded diagnostic code", async () => {
    const f = fixture();
    f.list.mockRejectedValue(Error("private response/token/stack test marker"));
    const facet = f.create();
    const result = await facet.start();
    expect(result).toMatchObject({
        assessment: null,
        problem: { code: "notifications_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(f.write).not.toHaveBeenCalled();
});
it("caller abort fences delivery but retains the occupied original READ and signal until its reply", async () => {
    const f = fixture();
    let release!: () => void;
    f.list.mockImplementation(async (namespace) => {
        await new Promise<void>((r) => {
            release = r;
        });
        return { namespace, timers: [] };
    });
    const facet = f.create(),
        caller = new AbortController(),
        first = facet.refresh({ signal: caller.signal });
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    caller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(f.list.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await expect(facet.refresh()).rejects.toMatchObject({
        reason: "notification_readiness_busy",
    });
    expect(f.list).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(facet.getSnapshot().checking).toBe(false));
    f.list.mockResolvedValueOnce({
        namespace: "fixture.reminders",
        timers: [],
    });
    await facet.refresh();
    expect(f.list).toHaveBeenCalledTimes(2);
});
it("close settles delivery without closing borrowed timers, and late reply never restores assessment", async () => {
    const f = fixture();
    let release!: () => void;
    f.list.mockImplementation(async (namespace) => {
        await new Promise<void>((r) => {
            release = r;
        });
        return { namespace, timers: [] };
    });
    const facet = f.create(),
        result = facet.start();
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    facet.close();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(f.borrowedClose).not.toHaveBeenCalled();
    expect(f.list.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    const closed = facet.getSnapshot();
    expect(facet.getSnapshot()).toBe(closed);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(facet.getSnapshot()).toBe(closed);
    expect(closed.assessment).toBeNull();
    await expect(facet.refresh()).rejects.toMatchObject({ code: "cancelled" });
});
it("original lifetime abort cancels pending delivery and suppresses a late result", async () => {
    const f = fixture();
    let release!: () => void;
    f.list.mockImplementation(async (namespace) => {
        await new Promise<void>((r) => {
            release = r;
        });
        return { namespace, timers: [] };
    });
    const facet = f.create(),
        result = facet.start();
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.lifetime.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(facet.getSnapshot().assessment).toBeNull();
    expect(f.borrowedClose).not.toHaveBeenCalled();
});
it("source change after await fences publication and sanitizes throwing currentness", async () => {
    const f = fixture();
    f.list.mockImplementation(async (namespace) => {
        f.change();
        return { namespace, timers: [] };
    });
    const facet = f.create();
    await expect(facet.start()).rejects.toMatchObject({ code: "cancelled" });
    expect(facet.getSnapshot()).toMatchObject({
        assessment: null,
        problem: { code: "notifications_fenced" },
    });
    const other = createApplicationNotificationReadiness({
        ...fixture().options,
        isCurrent: () => {
            throw Error("private currentness");
        },
    });
    cleanup.push(other.close);
    await expect(other.start()).rejects.toMatchObject({ code: "cancelled" });
    expect(JSON.stringify(other.getSnapshot())).not.toContain("private");
});
it.each(["collection", "generation", "namespace"])(
    "captures original %s and fences changed values after the READ",
    async (field) => {
        const f = fixture();
        f.list.mockImplementation(async (namespace) => {
            if (field === "generation")
                Object.assign(f.options, { generation: "changed" });
            else if (field === "namespace")
                Object.assign(f.options.notifications!, {
                    timerNamespace: "changed",
                });
            else Object.assign(f.options.scope, { [field]: "changed" });
            return { namespace, timers: [] };
        });
        const facet = f.create();
        await expect(facet.start()).rejects.toMatchObject({
            code: "cancelled",
        });
        expect(facet.getSnapshot().assessment).toBeNull();
        expect(f.write).not.toHaveBeenCalled();
    },
);
it("pre-aborted caller never dispatches or consumes start", async () => {
    const f = fixture(),
        facet = f.create();
    await expect(
        facet.start({ signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.list).not.toHaveBeenCalled();
    await facet.start();
    expect(f.list).toHaveBeenCalledOnce();
});
it("same-read slot is installed before listeners can synchronously request another refresh", async () => {
    const f = fixture(),
        facet = f.create();
    let overlap: Promise<unknown> | undefined;
    const stop = facet.subscribe(() => {
        if (facet.getSnapshot().checking && !overlap)
            overlap = facet.refresh().catch((error) => error);
    });
    await facet.start();
    expect(await overlap).toMatchObject({
        reason: "notification_readiness_busy",
    });
    expect(f.list).toHaveBeenCalledOnce();
    stop();
});
it("listener-triggered close cannot publish ready or leak listeners", async () => {
    const f = fixture(),
        facet = createApplicationNotificationReadiness({
            ...f.options,
            notifications: { declaration: null },
        });
    cleanup.push(facet.close);
    const listener = vi.fn(() => facet.close());
    facet.subscribe(listener);
    await expect(facet.start()).rejects.toMatchObject({ code: "cancelled" });
    const count = listener.mock.calls.length;
    expect(facet.getSnapshot().assessment).toBeNull();
    facet.close();
    expect(listener).toHaveBeenCalledTimes(count);
    expect(f.list).not.toHaveBeenCalled();
});
