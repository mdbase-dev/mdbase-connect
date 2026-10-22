// Actual public SDK/MdbasePeopleClient with controlled metadata authority;
// not native Person, browser consent or production authority acceptance.
import { afterEach, expect, it, vi } from "vitest";
import {
    connect,
    MdbasePeopleClient,
    MdbaseError,
    type MdbaseClient,
    type PeopleAuthority,
} from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import {
    createApplicationPeopleReadiness,
    type ApplicationPeopleReadinessOptions,
} from "../src/application/people-readiness.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const close of cleanup.splice(0).reverse()) close();
});
const profile = {
    issuer: "https://id.example.invalid",
    subject: "exact-subject",
    name: "Fixture User",
};
async function fixture() {
    const client: MdbaseClient = await connect({
        connector: new MemoryReplica().connector(),
        app: { name: "People readiness test", version: "test" },
        reconnect: false,
    });
    cleanup.push(() => client.close());
    let account: unknown = { ...profile },
        members: unknown = { members: [{ ...profile, role: "owner" }] },
        current = true;
    const lifetime = new AbortController();
    const request = vi.fn<PeopleAuthority["request"]>(async (resource) =>
        resource === "identity" ? account : members,
    );
    const authority: PeopleAuthority = {
        collection: "33333333-3333-4333-8333-333333333333",
        request,
        isCurrent: () => current,
    };
    const people = new MdbasePeopleClient(client, authority),
        projection = vi.spyOn(client, "queryContract"),
        directory = vi.spyOn(people, "directory");
    const options: ApplicationPeopleReadinessOptions = {
        people,
        scope: {
            account: "11111111-1111-4111-8111-111111111111",
            installation: "22222222-2222-4222-8222-222222222222",
            collection: authority.collection,
        },
        generation: "fixture-generation",
        signal: lifetime.signal,
        isCurrent: () => current,
    };
    function create() {
        const facet = createApplicationPeopleReadiness(options);
        cleanup.push(facet.close);
        return facet;
    }
    return {
        client,
        people,
        options,
        create,
        request,
        projection,
        directory,
        lifetime,
        change: () => {
            current = false;
        },
        account: (value: unknown) => {
            account = value;
        },
        members: (value: unknown) => {
            members = value;
        },
    };
}
it("sequences identity then members and publishes a frozen metadata-only facet", async () => {
    const f = await fixture(),
        facet = f.create(),
        observer = vi.fn();
    facet.subscribe(observer);
    expect(Object.isFrozen(facet)).toBe(true);
    expect(facet.getSnapshot().assessment).toBeNull();
    expect(f.request).not.toHaveBeenCalled();
    const result = await facet.start();
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
        "identity",
        "members",
    ]);
    expect(result).toMatchObject({
        checking: false,
        assessment: { status: "ready", problem: null },
        problem: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assessment)).toBe(true);
    expect(observer).toHaveBeenCalled();
    expect(f.projection).not.toHaveBeenCalled();
    expect(f.directory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(profile.subject);
});
it("genuine complete empty members is valid, not a manufactured permission decline", async () => {
    const f = await fixture();
    f.members({ members: [] });
    expect((await f.create().start()).assessment?.status).toBe("ready");
});
it.each(["identity", "members"] as const)(
    "failed %s READ has null assessment and only a safe diagnostic code",
    async (lane) => {
        const f = await fixture();
        f.request.mockImplementation(async (resource) => {
            if (resource === lane)
                throw Error("private error/token/body/stack marker");
            return profile;
        });
        const result = await f.create().start();
        expect(result).toMatchObject({
            assessment: null,
            problem: { code: "people_unavailable" },
        });
        expect(JSON.stringify(result)).not.toContain("private");
        expect(f.request).toHaveBeenCalledTimes(lane === "identity" ? 1 : 2);
    },
);
it.each(["people_permission_declined"])(
    "mandatory members %s refusal never becomes ready or an empty directory",
    async (reason) => {
        const f = await fixture();
        f.request.mockImplementation(async (resource) => {
            if (resource === "members")
                throw new MdbaseError({
                    code: "forbidden",
                    recovery: "none",
                    reason,
                    message: "controlled refusal",
                });
            return profile;
        });
        expect(await f.create().start()).toMatchObject({
            assessment: null,
            problem: { code: "people_unavailable" },
        });
        expect(f.directory).not.toHaveBeenCalled();
    },
);
it("caller cancellation retains the original READ/assessment slot and stable signal through sequential replies", async () => {
    const f = await fixture();
    let release!: () => void;
    f.request.mockImplementation(async (resource) => {
        if (resource === "identity")
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        return resource === "identity" ? profile : { members: [] };
    });
    const facet = f.create(),
        caller = new AbortController(),
        result = facet.refresh({ signal: caller.signal });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    caller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(f.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await expect(facet.refresh()).rejects.toMatchObject({
        reason: "people_readiness_busy",
    });
    expect(f.request).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(facet.getSnapshot().checking).toBe(false));
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
        "identity",
        "members",
    ]);
    f.request.mockImplementation(async (resource) =>
        resource === "identity" ? profile : { members: [] },
    );
    await facet.refresh();
    expect(f.request).toHaveBeenCalledTimes(4);
});
it("close rejects pending delivery, sends no second READ and cannot close the borrowed client", async () => {
    const f = await fixture();
    let release!: () => void;
    f.request.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        return profile;
    });
    const closed = vi.spyOn(f.client, "close"),
        facet = f.create(),
        result = facet.start();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    facet.close();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(closed).not.toHaveBeenCalled();
    expect(f.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    const stopped = facet.getSnapshot();
    expect(facet.getSnapshot()).toBe(stopped);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facet.getSnapshot()).toBe(stopped);
    expect(f.request).toHaveBeenCalledOnce();
});
it("original lifetime abort fences delivery and suppresses late metadata", async () => {
    const f = await fixture();
    let release!: () => void;
    f.request.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        return profile;
    });
    const facet = f.create(),
        result = facet.start();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.lifetime.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(facet.getSnapshot().assessment).toBeNull();
    expect(f.request).toHaveBeenCalledOnce();
});
it.each(["identity", "members"] as const)(
    "scope loss during %s suppresses the entire assessment and later READs",
    async (lane) => {
        const f = await fixture();
        f.request.mockImplementation(async (resource) => {
            if (resource === lane) f.change();
            return resource === "identity" ? profile : { members: [] };
        });
        const facet = f.create();
        await expect(facet.start()).rejects.toMatchObject({
            code: "cancelled",
        });
        expect(facet.getSnapshot().assessment).toBeNull();
        expect(f.request).toHaveBeenCalledTimes(lane === "identity" ? 1 : 2);
    },
);
it.each(["collection", "generation"])(
    "changed original %s is fenced after await",
    async (field) => {
        const f = await fixture();
        f.request.mockImplementation(async () => {
            if (field === "generation")
                Object.assign(f.options, { generation: "changed" });
            else Object.assign(f.options.scope, { [field]: "changed" });
            return profile;
        });
        const facet = f.create();
        await expect(facet.start()).rejects.toMatchObject({
            code: "cancelled",
        });
        expect(facet.getSnapshot().assessment).toBeNull();
        expect(f.request).toHaveBeenCalledOnce();
    },
);
it("refresh clears previous readiness and failed requalification stays null", async () => {
    const f = await fixture(),
        facet = f.create();
    expect((await facet.start()).assessment?.status).toBe("ready");
    f.request.mockRejectedValue(Error("controlled READ failure"));
    const result = facet.refresh();
    expect(facet.getSnapshot()).toMatchObject({
        checking: true,
        assessment: null,
    });
    expect((await result).assessment).toBeNull();
});
it("pre-aborted start does not dispatch or consume start; repeated start uses the same assessment", async () => {
    const f = await fixture(),
        facet = f.create();
    await expect(
        facet.start({ signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.request).not.toHaveBeenCalled();
    await facet.start();
    await facet.start();
    expect(f.request).toHaveBeenCalledTimes(2);
});
it("reentrant refresh cannot overlap metadata and listener-triggered close cannot publish ready", async () => {
    const f = await fixture(),
        facet = f.create();
    let overlap: Promise<unknown> | undefined;
    const stop = facet.subscribe(() => {
        if (facet.getSnapshot().checking && !overlap)
            overlap = facet.refresh().catch((error) => error);
    });
    await facet.start();
    expect(await overlap).toMatchObject({ reason: "people_readiness_busy" });
    expect(f.request).toHaveBeenCalledTimes(2);
    stop();
    facet.subscribe(() => facet.close());
    await expect(facet.refresh()).rejects.toMatchObject({ code: "cancelled" });
    expect(facet.getSnapshot().assessment).toBeNull();
});
it("bounded account/member DTO evidence is required, never a silently truncated prefix", async () => {
    const f = await fixture();
    f.account({ ...profile, name: "é".repeat(2049) });
    const facet = f.create();
    expect((await facet.start()).assessment).toBeNull();
    expect(f.request).toHaveBeenCalledOnce();
    f.account(profile);
    f.members({ members: Array(1001).fill({ ...profile, role: "owner" }) });
    expect((await facet.refresh()).assessment).toBeNull();
    f.members({ members: [{ ...profile, role: "invented" }] });
    expect((await facet.refresh()).assessment).toBeNull();
});
it("throwing source diagnostics are sanitized and unsupported methods cannot be ready", async () => {
    const f = await fixture(),
        broken = createApplicationPeopleReadiness({
            ...f.options,
            isCurrent: () => {
                throw Error("private diagnostic");
            },
        });
    cleanup.push(broken.close);
    await expect(broken.start()).rejects.toMatchObject({ code: "cancelled" });
    expect(JSON.stringify(broken.getSnapshot())).not.toContain("private");
    Object.assign(f.options, { people: undefined });
    const unsupported = f.create();
    expect(await unsupported.start()).toMatchObject({
        assessment: null,
        problem: { code: "people_unsupported" },
    });
});
