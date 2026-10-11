// Canonical public parser + controlled CP metadata replies; no actor/DB/Worker allocation.
import { afterEach, expect, it, vi } from "vitest";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import { resolveApplicationRegistration } from "../src/application/registration.js";
import type { MdbaseApplicationDeclaration } from "../src/application/declaration.js";
import * as trust from "../src/application/packaged-trust.js";
const id = "5cdfa020-c201-4da8-845a-f2cc9969eade",
    other = "33333333-3333-4333-8333-333333333333";
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});
function fixture(logical = false) {
    vi.spyOn(trust, "appReleaseTrust").mockReturnValue({
        schema: "mdbn-app-trust/release/1",
        environment: "lab",
        cpOrigin: "https://cp.example.test",
        logOrigin: "https://log.example.test",
        assetSha256: "aa".repeat(32),
        source: {
            repository: "mdbase-dev/mdbase-connect",
            commit: "bb".repeat(20),
            version: "test",
        },
        trustedRoots: [new Uint8Array(32).fill(1)],
        policyPins: Uint8Array.of(1),
    });
    const manifest = {
        manifest_version: 1 as const,
        id: "dev.tasknotes.web",
        name: "TaskNotes",
        homepage: "http://127.0.0.1:48218",
        redirect_uris: ["http://127.0.0.1:48218/callback"],
        requirements: {
            access: "full_collection" as const,
            contracts: [],
            capabilities: {
                contract_version: 2 as const,
                required: [],
                optional: [],
            },
        },
    };
    const canonical = parseVersionedAppManifest(manifest, {
        allowLocal: true,
    }).manifest;
    const declaration: MdbaseApplicationDeclaration = {
        id: logical ? "tasknotes" : id,
        name: "TaskNotes",
        origin: "http://127.0.0.1:48218",
        environment: "lab",
        manifest,
    };
    const reply = () => ({
        application: {
            id,
            name: "TaskNotes",
            manifest_digest: "cc".repeat(32),
            canonical_identity: `bundle:dev.tasknotes.web:sha256:${"cc".repeat(32)}`,
            family_identity: "bundle:dev.tasknotes.web",
            distribution: "web",
            application_declaration: canonical,
        },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
            Response.json(reply()),
        ),
        controller = new AbortController();
    let current = true;
    const input = {
        declaration,
        signal: controller.signal,
        isCurrent: () => current,
        fetch,
    };
    return {
        input,
        reply,
        fetch,
        controller,
        change: () => {
            current = false;
        },
    };
}
it.each([false, true])(
    "registers exact canonical metadata for known/logical identity %s without any allocation seam",
    async (logical) => {
        const f = fixture(logical),
            result = await resolveApplicationRegistration(f.input);
        expect(result).toEqual({
            id,
            name: "TaskNotes",
            manifestDigest: "cc".repeat(32),
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(f.fetch).toHaveBeenCalledOnce();
        const [url, options] = f.fetch.mock.calls[0]!;
        expect(url).toBe("https://cp.example.test/v1/apps/register");
        expect(options).toMatchObject({
            method: "POST",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            referrerPolicy: "no-referrer",
        });
        expect(JSON.parse(options!.body as string)).toEqual({
            manifest: parseVersionedAppManifest(f.input.declaration.manifest, {
                allowLocal: true,
            }).manifest,
        });
        expect(options!.headers).not.toHaveProperty("authorization");
    },
);
it.each(["native-id", "manifest", "digest"])(
    "rejects mismatching %s evidence, never inventing a registered identity",
    async (mismatch) => {
        const f = fixture(),
            reply = f.reply();
        if (mismatch === "native-id") reply.application.id = other;
        if (mismatch === "manifest")
            reply.application.application_declaration.name = "Other";
        if (mismatch === "digest")
            reply.application.manifest_digest = "not-a-digest";
        f.fetch.mockImplementation(async () => Response.json(reply));
        await expect(
            resolveApplicationRegistration(f.input),
        ).rejects.toMatchObject({
            reason:
                mismatch === "native-id"
                    ? "application_registration_binding"
                    : "application_registration_response",
        });
        expect(f.fetch).toHaveBeenCalledOnce();
    },
);
it("captures one immutable metadata upsert and safely repeats only identical bytes after transient loss", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    let body: string | undefined;
    f.fetch.mockImplementationOnce(async (_url, options) => {
        body = options!.body as string;
        throw new TypeError("private lost registration reply");
    });
    const result = resolveApplicationRegistration(f.input).then(
        (value) => ({ value }),
        (error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toHaveProperty("value");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[1]![1]!.body).toBe(body);
    expect(vi.getTimerCount()).toBe(0);
});
it("bounded immutable-upsert exhaustion preserves outcome_unknown; permanent refusal never retries", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    const error = resolveApplicationRegistration(f.input).catch(
        (error) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1250);
    expect(await error).toMatchObject({
        code: "outcome_unknown",
        reason: "application_registration_unknown",
    });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    const denied = fixture();
    denied.fetch.mockImplementation(
        async () => new Response(null, { status: 403 }),
    );
    await expect(
        resolveApplicationRegistration(denied.input),
    ).rejects.toMatchObject({
        code: "forbidden",
        reason: "application_registration_refused",
    });
    expect(denied.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
it.each(["abort", "current", "declaration"])(
    "fences late registration after %s change with no successor request",
    async (change) => {
        const f = fixture();
        f.fetch.mockImplementation(async () => {
            if (change === "abort") f.controller.abort();
            if (change === "current") f.change();
            if (change === "declaration")
                Object.assign(f.input.declaration, { name: "Replacement" });
            return Response.json(f.reply());
        });
        await expect(
            resolveApplicationRegistration(f.input),
        ).rejects.toMatchObject({ code: "cancelled" });
        expect(f.fetch).toHaveBeenCalledOnce();
    },
);
it("invalid manifest/origin and missing packaged trust refuse before CP", async () => {
    const f = fixture();
    Object.assign(f.input.declaration, {
        origin: "https://foreign.example.test",
    });
    await expect(resolveApplicationRegistration(f.input)).rejects.toMatchObject(
        { reason: "application_registration_binding" },
    );
    expect(f.fetch).not.toHaveBeenCalled();
    const absent = fixture();
    vi.mocked(trust.appReleaseTrust).mockImplementation(() => {
        throw Error("private build diagnostic");
    });
    await expect(
        resolveApplicationRegistration(absent.input),
    ).rejects.toMatchObject({ reason: "application_registration_unavailable" });
    expect(absent.fetch).not.toHaveBeenCalled();
});
it("malformed success JSON never inherits network/upsert retries", async () => {
    const f = fixture();
    f.fetch.mockImplementation(
        async () => new Response("private invalid JSON"),
    );
    await expect(resolveApplicationRegistration(f.input)).rejects.toMatchObject(
        { reason: "application_registration_response" },
    );
    expect(f.fetch).toHaveBeenCalledOnce();
});
it("caller cancellation during retry backoff releases owned timers and prevents a successor", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetch.mockImplementation(async () => {
        throw Error("private network diagnostic");
    });
    const failure = resolveApplicationRegistration(f.input).catch(
        (error) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    f.controller.abort();
    expect(await failure).toMatchObject({ code: "cancelled" });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
it("headerless oversized streams are bounded too, with no metadata retry", async () => {
    const f = fixture();
    let cancelled = false;
    f.fetch.mockImplementation(
        async () =>
            new Response(
                new ReadableStream({
                    pull(control) {
                        control.enqueue(new Uint8Array(1200000));
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
            ),
    );
    await expect(resolveApplicationRegistration(f.input)).rejects.toMatchObject(
        { reason: "application_registration_response" },
    );
    expect(cancelled).toBe(true);
    expect(f.fetch).toHaveBeenCalledOnce();
});
it("oversized reply is refused without reading a truncated declaration or disclosing response diagnostics", async () => {
    const f = fixture();
    f.fetch.mockImplementation(
        async () =>
            new Response("private body", {
                headers: { "content-length": "2000000" },
            }),
    );
    const error = await resolveApplicationRegistration(f.input).catch(
        (error) => error,
    );
    expect(error).toMatchObject({
        reason: "application_registration_response",
    });
    expect(error.message).not.toContain("private");
    expect(f.fetch).toHaveBeenCalledOnce();
});
