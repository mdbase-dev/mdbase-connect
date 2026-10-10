import { describe, expect, it, vi } from "vitest";
import {
    AppCpCloudCopyBootstrap,
    type AppCloudCopyBootstrapPersistence,
    type AppCloudCopyOutcome,
    type AppBundledReleaseTrust,
    type AppCpCloudCopySession,
} from "../src/app-host/cloud-copy-bootstrap.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
function fixture(purpose: "create" | "join" = "create") {
    const now = 1791417600000,
        source: AppCpCloudCopySession = {
            accountId: "11111111-1111-1111-1111-111111111111",
            connectorId: "66666666-6666-6666-6666-666666666666",
            deviceId: "44444444-4444-4444-4444-444444444444",
            installationId: "88888888-8888-8888-8888-888888888888",
            collection: "22222222-2222-2222-2222-222222222222",
            purpose,
            approvalMode: "password-ak1",
            cpOrigin: "https://cp.example.test",
            logOrigin: "https://log.example.test",
            isCurrent: () => true,
            installationOwned: () => true,
            connectorBearer: vi.fn(async () => "public-connector-fixture"),
        };
    const trust: AppBundledReleaseTrust = {
        schema: "mdbn-app-trust/release/1",
        environment: "test",
        cpOrigin: source.cpOrigin,
        logOrigin: source.logOrigin,
        assetSha256: "aa".repeat(32),
        source: {
            repository: "mdbase-dev/mdbase-connect",
            commit: "bb".repeat(20),
            version: "0.0.0-test",
        },
        trustedRoots: [new Uint8Array(32).fill(9)],
        policyPins: Uint8Array.of(0x82),
    };
    const receipt = {
            connectorId: source.connectorId,
            deviceId: source.deviceId,
            installationId: source.installationId,
            signPublicKey: new Uint8Array(32).fill(1),
            kemPublicKey: new Uint8Array(32).fill(2),
            noisePublicKey: new Uint8Array(32).fill(3),
        },
        native = {
            cloudCopyCollectionCurrent: vi.fn(() => true),
            registeredDeviceReceipt: vi.fn(() => receipt),
            signCloudCopyCreate: vi.fn(() => new Uint8Array(64).fill(7)),
            signCloudCopyJoin: vi.fn(() => new Uint8Array(64).fill(8)),
            retireLog: vi.fn(),
            adoptDevice: vi.fn(),
        };
    const state = { outcome: { state: "none" } as AppCloudCopyOutcome };
    const persistence: AppCloudCopyBootstrapPersistence = {
        restore: vi.fn(async () => state.outcome),
        pending: vi.fn(async (operation) => {
            state.outcome = {
                state: "pending",
                operation: structuredClone(operation),
            };
        }),
        completed: vi.fn(async (metadata) => {
            state.outcome = {
                state: "completed",
                metadata: structuredClone(metadata),
            };
        }),
    };
    const response = () => ({
        collection_id: source.collection,
        state: "cloud-copy",
        owner_account: source.accountId,
        root_public_key: "09".repeat(32),
        log_url: source.logOrigin,
        genesis: { seq: 1, item: "1122" },
        enrolled_at: 2,
        device: {
            device_id: source.deviceId,
            token: "public-token-fixture",
            expires_at: now + 600000,
        },
        head: { seq: 999, chain: "00".repeat(32) },
        rekey_recipients: ["foreign-advisory"],
    });
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("error");
        expect(init?.cache).toBe("no-store");
        expect(init?.referrerPolicy).toBe("no-referrer");
        expect((init?.headers as Record<string, string>).authorization).toBe(
            "Bearer public-connector-fixture",
        );
        const path = new URL(String(url)).pathname;
        return Response.json(
            path === "/v1/next/devices/challenge"
                ? { challenge: "11".repeat(32), expires_at: now + 60000 }
                : response(),
        );
    });
    const signal = new AbortController().signal,
        create = (displayName?: string) =>
            new AppCpCloudCopyBootstrap(
                native as unknown as AppWasmRuntime,
                source,
                trust,
                persistence,
                { fetch, now: () => now, allowLoopbackHttp: true, ...(displayName === undefined ? {} : {displayName}) },
            );
    return {
        source,
        trust,
        native,
        state,
        persistence,
        fetch,
        response,
        signal,
        create,
        now,
    };
}
describe("first-party cloud-copy CP bootstrap (protocol/native/persistence stand-ins)", () => {
    it("captures and protects the normalized explicit create label before bearer/challenge/POST", async () => {
        const f = fixture(), host = f.create("  Research  ");
        const metadata = await host.bootstrap({signal: f.signal});
        const body = JSON.parse(f.fetch.mock.calls[1]![1]!.body as string);
        expect(body.display_name).toBe("Research");
        expect(vi.mocked(f.persistence.pending).mock.calls[0]![0].displayName).toBe("Research");
        expect(metadata.operation.displayName).toBe("Research");
        expect(vi.mocked(f.persistence.pending).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.source.connectorBearer).mock.invocationCallOrder[0]!);
        await expect(f.create("Other").bootstrap({signal: f.signal, reconcile: "explicit-unknown-outcome"})).rejects.toMatchObject({reason: "response"});
        expect(f.fetch).toHaveBeenCalledTimes(2);
    });
    it("captures optional name exactly once before any await and ignores later caller option mutation", async () => {
        const f = fixture(); let label = "  Research  "; let reads = 0;
        const options = {fetch: f.fetch, now: () => f.now, allowLoopbackHttp: true, get displayName() { reads++; return label; }};
        const host = new AppCpCloudCopyBootstrap(f.native as unknown as AppWasmRuntime, f.source, f.trust, f.persistence, options);
        expect(reads).toBe(1); label = "Other";
        await host.bootstrap({signal: f.signal});
        expect(reads).toBe(1); expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string).display_name).toBe("Research");
        expect(vi.mocked(f.persistence.pending).mock.calls[0]![0].displayName).toBe("Research");
    });
    it("rejects raw-invalid names and name on join before any asynchronous operation", () => {
        const f = fixture(); expect(() => f.create("Research\n")).toThrow("binding");
        expect(f.persistence.restore).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
        const join = fixture("join"); expect(() => join.create("Research")).toThrow("binding");
        expect(join.fetch).not.toHaveBeenCalled();
    });
    it("adopts only confirmed completion with SAME bundled authority, no metadata/state/root overrides", async () => {
        const f = fixture(),
            host = f.create(),
            metadata = await host.bootstrap({ signal: f.signal }),
            expected = metadata.expectedGenesis;
        metadata.genesisItem.fill(0);
        metadata.operation.noisePublicKey.fill(0);
        const sql = { import: vi.fn(), fence: vi.fn(), needsRecovery: false };
        host.adoptCollection(
            {
                signal: f.signal,
                replicaId: "99999999-9999-9999-9999-999999999999",
                endpoint: 37,
                opened: "fresh",
                sqliteVersion: 3050004,
                cloudCopyOptIn: true,
            },
            sql,
        );
        const [config, binding] = f.native.adoptDevice.mock
            .calls[0]! as unknown as [Record<string, unknown>, unknown];
        expect(binding).toBe(sql);
        expect(config.collection).toBe(f.source.collection);
        expect(config.expectedGenesis).toBe(expected);
        expect(config.state).toBe("cloud_copy");
        expect(config.cloudCopyOptIn).toBe(true);
        expect(config.trustedRoots).toEqual(f.trust.trustedRoots);
        expect(config.policyPins).toEqual(f.trust.policyPins);
        expect(config).not.toHaveProperty("signSecretKey");
        expect(() =>
            host.adoptCollection(
                {
                    signal: f.signal,
                    replicaId: "99999999-9999-9999-9999-999999999999",
                    endpoint: 37,
                    opened: "fresh",
                    sqliteVersion: 3050004,
                    cloudCopyOptIn: true,
                },
                sql,
            ),
        ).toThrow();
        expect(f.native.adoptDevice).toHaveBeenCalledTimes(1);
    });
    it.each(["unconfirmed", "no-opt-in", "trust-drift"])(
        "adoption %s refuses before native/SQL",
        async (change) => {
            const f = fixture(),
                host = f.create();
            if (change !== "unconfirmed")
                await host.bootstrap({ signal: f.signal });
            if (change === "trust-drift") f.trust.policyPins.fill(0);
            const sql = {
                import: vi.fn(),
                fence: vi.fn(),
                needsRecovery: false,
            };
            expect(() =>
                host.adoptCollection(
                    {
                        signal: f.signal,
                        replicaId: "99999999-9999-9999-9999-999999999999",
                        endpoint: 37,
                        opened: "fresh",
                        sqliteVersion: 3050004,
                        cloudCopyOptIn: (change !== "no-opt-in") as true,
                    },
                    sql,
                ),
            ).toThrow();
            expect(f.native.adoptDevice).not.toHaveBeenCalled();
            expect(sql.import).not.toHaveBeenCalled();
        },
    );
    it("calls captured fetch as a free function, never with the host receiver", async () => {
        const f = fixture(),
            original = f.fetch.getMockImplementation()!;
        f.fetch.mockImplementation(function (
            this: unknown,
            url: RequestInfo | URL,
            init?: RequestInit,
        ) {
            expect(this).toBeUndefined();
            return original(url, init);
        });
        await f.create().bootstrap({ signal: f.signal });
        expect(f.fetch).toHaveBeenCalledTimes(2);
    });
    it.each(["create", "join"] as const)(
        "fixed %s route/original native domain, pending BEFORE HTTP, completion without tokens/head/recipient authority",
        async (purpose) => {
            const f = fixture(purpose),
                result = await f.create().bootstrap({ signal: f.signal });
            expect(f.fetch).toHaveBeenCalledTimes(2);
            expect(
                (f.persistence.pending as ReturnType<typeof vi.fn>).mock
                    .invocationCallOrder[0],
            ).toBeLessThan(f.fetch.mock.invocationCallOrder[0]!);
            const [url, request] = f.fetch.mock.calls[1]!;
            expect(new URL(String(url)).pathname).toBe(
                purpose === "create"
                    ? "/v1/next/collections/cloud-copy"
                    : `/v1/next/collections/${f.source.collection}/devices`,
            );
            const body = JSON.parse(request!.body as string);
            expect(body.device_id).toBe(f.source.deviceId);
            expect(body.challenge).toBe("11".repeat(32));
            expect(body.sig).toBe(
                (purpose === "create" ? "07" : "08").repeat(64),
            );
            expect(Object.keys(body).sort()).toEqual(
                purpose === "create"
                    ? ["challenge", "collection_id", "device_id", "sig"]
                    : ["challenge", "device_id", "sig"],
            );
            expect(
                purpose === "create"
                    ? f.native.signCloudCopyJoin
                    : f.native.signCloudCopyCreate,
            ).not.toHaveBeenCalled();
            expect(result.expectedGenesis).toMatch(/^sha256:[0-9a-f]{64}$/);
            expect(Object.keys(result).sort()).toEqual([
                "expectedGenesis",
                "genesisItem",
                "operation",
            ]);
            expect(f.state.outcome.state).toBe("completed");
            expect(f.native.retireLog).not.toHaveBeenCalled();
        },
    );
    it.each(["aborted-original", "replacement-signal"])(
        "adoption %s cannot detach original bootstrap lifetime",
        async (change) => {
            const f = fixture(),
                host = f.create(),
                original = new AbortController();
            await host.bootstrap({ signal: original.signal });
            if (change === "aborted-original") original.abort();
            const sql = {
                import: vi.fn(),
                fence: vi.fn(),
                needsRecovery: false,
            };
            expect(() =>
                host.adoptCollection(
                    {
                        signal:
                            change === "replacement-signal"
                                ? new AbortController().signal
                                : original.signal,
                        replicaId: "99999999-9999-9999-9999-999999999999",
                        endpoint: 37,
                        opened: "fresh",
                        sqliteVersion: 3050004,
                        cloudCopyOptIn: true,
                    },
                    sql,
                ),
            ).toThrow();
            expect(f.native.adoptDevice).not.toHaveBeenCalled();
            expect(sql.import).not.toHaveBeenCalled();
        },
    );
    it("restores confirmed completion before credential/challenge/proof/network; owned copies cannot mutate successor", async () => {
        const f = fixture();
        const first = await f.create().bootstrap({ signal: f.signal });
        f.fetch.mockClear();
        (f.source.connectorBearer as ReturnType<typeof vi.fn>).mockClear();
        f.native.signCloudCopyCreate.mockClear();
        const restored = await f.create().bootstrap({ signal: f.signal });
        expect(f.fetch).not.toHaveBeenCalled();
        expect(f.source.connectorBearer).not.toHaveBeenCalled();
        expect(f.native.signCloudCopyCreate).not.toHaveBeenCalled();
        restored.genesisItem.fill(0);
        restored.operation.noisePublicKey.fill(0);
        const next = await f.create().bootstrap({ signal: f.signal });
        expect(next.genesisItem).toEqual(first.genesisItem);
        expect(next.operation.noisePublicKey.every((v) => v === 3)).toBe(true);
    });
    it("pending unknown refuses default replay; only explicit original-operation reconciliation signs/posts", async () => {
        const f = fixture();
        f.persistence.completed = async () => {
            throw Error("unknown committed completion");
        };
        await expect(
            f.create().bootstrap({ signal: f.signal }),
        ).rejects.toMatchObject({ reason: "unavailable" });
        expect(f.state.outcome.state).toBe("pending");
        f.fetch.mockClear();
        await expect(
            f.create().bootstrap({ signal: f.signal }),
        ).rejects.toMatchObject({ reason: "outcome_unknown" });
        expect(f.fetch).not.toHaveBeenCalled();
        f.persistence.completed = async (metadata) => {
            f.state.outcome = {
                state: "completed",
                metadata: structuredClone(metadata),
            };
        };
        await f.create().bootstrap({
            signal: f.signal,
            reconcile: "explicit-unknown-outcome",
        });
        expect(f.fetch).toHaveBeenCalledTimes(2);
    });
    it("applied-lost completion is restored after explicit reopen without HTTP", async () => {
        const f = fixture(),
            completed = f.persistence.completed;
        f.persistence.completed = async (m, o) => {
            await completed(m, o);
            throw Error("private committed storage diagnostic");
        };
        await expect(
            f.create().bootstrap({ signal: f.signal }),
        ).rejects.toThrow("app cloud copy bootstrap: unavailable");
        expect(f.state.outcome.state).toBe("completed");
        f.fetch.mockClear();
        const restored = await f.create().bootstrap({ signal: f.signal });
        expect(restored.genesisItem).toEqual(Uint8Array.of(0x11, 0x22));
        expect(f.fetch).not.toHaveBeenCalled();
    });
    it("failed pending preservation cannot access credentials/challenge/native proof", async () => {
        const f = fixture();
        f.persistence.pending = async () => {
            throw Error("CAS uncertain");
        };
        await expect(
            f.create().bootstrap({ signal: f.signal }),
        ).rejects.toMatchObject({ reason: "unavailable" });
        expect(f.fetch).not.toHaveBeenCalled();
        expect(f.source.connectorBearer).not.toHaveBeenCalled();
        expect(f.native.signCloudCopyCreate).not.toHaveBeenCalled();
    });
    it.each([
        "foreign-log",
        "foreign-owner",
        "foreign-root",
        "private-state",
        "foreign-device",
        "invalid-token",
        "bad-genesis",
    ])(
        "malformed/foreign response %s never persists completion",
        async (bad) => {
            const f = fixture(),
                good = f.response();
            if (bad === "foreign-log") good.log_url = "https://foreign.test";
            if (bad === "foreign-owner") good.owner_account = "foreign";
            if (bad === "foreign-root") good.root_public_key = "ff".repeat(32);
            if (bad === "private-state") good.state = "private";
            if (bad === "foreign-device") good.device.device_id = "foreign";
            if (bad === "invalid-token") good.device.token = "bad token";
            if (bad === "bad-genesis") good.genesis.seq = 2;
            f.fetch.mockImplementation(async (url) =>
                Response.json(
                    new URL(String(url)).pathname ===
                        "/v1/next/devices/challenge"
                        ? {
                              challenge: "11".repeat(32),
                              expires_at: f.now + 60000,
                          }
                        : good,
                ),
            );
            await expect(
                f.create().bootstrap({ signal: f.signal }),
            ).rejects.toMatchObject({ reason: "response" });
            expect(f.persistence.completed).not.toHaveBeenCalled();
            expect(f.state.outcome.state).toBe("pending");
        },
    );
    it.each([
        "callback",
        "ownership",
        "storage-callback",
        "trust-origin",
        "root-buffer",
        "pin-buffer",
        "scope",
    ])("late %s drift after await fences before HTTP", async (change) => {
        const f = fixture(),
            original = f.persistence.pending;
        f.persistence.pending = async (m, o) => {
            await original(m, o);
            if (change === "callback")
                Object.assign(f.source, {
                    connectorBearer: async () => "replacement",
                });
            if (change === "ownership")
                Object.assign(f.source, { installationOwned: () => true });
            if (change === "storage-callback")
                f.persistence.completed = async () => {
                    throw Error("replacement must not execute");
                };
            if (change === "trust-origin")
                Object.assign(f.trust, { cpOrigin: "https://foreign.test" });
            if (change === "root-buffer") f.trust.trustedRoots[0]!.fill(0);
            if (change === "pin-buffer") f.trust.policyPins.fill(0);
            if (change === "scope")
                Object.assign(f.source, {
                    collection: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                });
        };
        await expect(
            f.create().bootstrap({ signal: f.signal }),
        ).rejects.toMatchObject({ reason: "fenced" });
        expect(f.fetch).not.toHaveBeenCalled();
    });
    it("native source/non-owner or foreign build context refuses before persistence/network", () => {
        for (const change of ["native", "owner", "origin"]) {
            const f = fixture();
            if (change === "native")
                f.native.cloudCopyCollectionCurrent.mockReturnValue(false);
            if (change === "owner")
                Object.assign(f.source, { installationOwned: () => false });
            if (change === "origin")
                Object.assign(f.trust, { logOrigin: "https://foreign.test" });
            expect(() => f.create()).toThrow(
                "app cloud copy bootstrap: binding",
            );
            expect(f.persistence.restore).not.toHaveBeenCalled();
            expect(f.fetch).not.toHaveBeenCalled();
        }
    });
    it("single attempt and original signal snapshot survive options replacement", async () => {
        const f = fixture(),
            controller = new AbortController(),
            options = { signal: controller.signal };
        const original = f.persistence.pending;
        f.persistence.pending = async (m, o) => {
            await original(m, o);
            options.signal = new AbortController().signal;
            controller.abort();
        };
        const host = f.create();
        await expect(host.bootstrap(options)).rejects.toMatchObject({
            reason: "fenced",
        });
        expect(f.fetch).not.toHaveBeenCalled();
        await expect(
            host.bootstrap({ signal: f.signal }),
        ).rejects.toMatchObject({ reason: "fenced" });
    });
});
