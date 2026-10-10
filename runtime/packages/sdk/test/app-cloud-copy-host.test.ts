import { afterEach, describe, expect, it, vi } from "vitest";
import {
    AppWebCloudCopyHost,
    type AppCloudCopyHostRelease,
    type AppCloudCopyHostSession,
} from "../src/app-host/cloud-copy-host.js";
import { AppIndexedDbDeviceKeyProvider } from "../src/app-host/device-key-provider.js";
import { AppIndexedDbDeviceKeyProtectedStore } from "../src/app-host/device-key-idb.js";
import { AppIndexedDbNoiseProtectedStore } from "../src/app-host/noise-idb.js";
import { AppWebDeviceKeyCustody } from "../src/app-host/device-key-custody.js";
import { AppWebNoiseCustody } from "../src/app-host/noise-custody.js";
import { AppCpDeviceRegistration } from "../src/app-host/device-registration.js";
import type { AppProtectedInstallationSignIn, AppInstallationSignInView } from "../src/app-host/installation-sign-in.js";
import { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
import {
    AppCpCloudCopyBootstrap,
    type AppCloudCopyBootstrapPersistence,
} from "../src/app-host/cloud-copy-bootstrap.js";
import { AppIndexedDbCloudCopyOutcomeStore } from "../src/app-host/cloud-copy-persistence-idb.js";
import { MdbaseClient } from "../src/client.js";
import { mdbaseError } from "../src/errors.js";
import { AppCpLogAuthority } from "../src/app-host/cp-authority.js";
import * as localFacade from "../src/app-host/local-facade.js";
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function fixture(mode: "fresh" | "existing" = "fresh") {
    const calls: string[] = [],
        origin = "https://app.example.test",
        signal = new AbortController().signal;
    vi.stubGlobal("location", { origin });
    const session: AppCloudCopyHostSession = {
        accountId: "11111111-1111-1111-1111-111111111111",
        connectorId: "66666666-6666-6666-6666-666666666666",
        deviceId: "44444444-4444-4444-4444-444444444444",
        installationId: "88888888-8888-8888-8888-888888888888",
        cpOrigin: "https://cp.example.test",
        logOrigin: "https://log.example.test",
        kind: "app-runtime",
        approvalMode: "password-ak1",
        isCurrent: () => true,
        connectorBearer: async () => "fixture-bearer",
    };
    const installation = {
        scope: Object.freeze({
            account: session.accountId,
            installation: session.installationId,
        }),
        isCurrent: () => true,
    };
    const release: AppCloudCopyHostRelease = {
        schema: "mdbn-app-trust/release/1",
        environment: "test",
        cpOrigin: session.cpOrigin,
        logOrigin: session.logOrigin,
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
            connectorId: session.connectorId,
            deviceId: session.deviceId,
            installationId: session.installationId,
            signPublicKey: new Uint8Array(32).fill(1),
            kemPublicKey: new Uint8Array(32).fill(2),
            noisePublicKey: new Uint8Array(32).fill(3),
        },
        custody = { ...receipt, envelope: Uint8Array.of(4, 5, 6) },
        key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );
    const provider = {
            deviceCustodyKek: vi.fn(() => {
                calls.push("kek-loan");
                return key;
            }),
            close: vi.fn(() => {
                calls.push("provider-close");
            }),
        },
        keys = {
            close: vi.fn(() => {
                calls.push("keys-close");
            }),
        },
        noiseStore = {
            close: vi.fn(() => {
                calls.push("noise-close");
            }),
        };
    const providerOpen = vi
        .spyOn(AppIndexedDbDeviceKeyProvider, "open")
        .mockImplementation(async () => {
            calls.push("provider-open");
            return provider as unknown as AppIndexedDbDeviceKeyProvider;
        });
    vi.spyOn(AppIndexedDbDeviceKeyProtectedStore, "open").mockImplementation(
        async () => {
            calls.push("keys-open");
            return keys as unknown as AppIndexedDbDeviceKeyProtectedStore;
        },
    );
    vi.spyOn(AppIndexedDbNoiseProtectedStore, "open").mockImplementation(
        async () => {
            calls.push("noise-open");
            return noiseStore as unknown as AppIndexedDbNoiseProtectedStore;
        },
    );
    const restore = vi
        .spyOn(AppWebNoiseCustody.prototype, "restore")
        .mockImplementation(async () => {
            calls.push("noise-restore");
            return mode === "fresh"
                ? null
                : {
                      envelope: new Uint8Array(custody.envelope),
                      receipt: structuredClone(receipt),
                      privateEnrolMarker: null,
                  };
        });
    const runtime = {
        close: vi.fn(async () => {
            calls.push("native-close");
            return true;
        }),
        acknowledgeDeviceRegistration: vi.fn(() => {
            calls.push("ack");
        }),
        registeredDeviceReceipt: vi.fn(() => structuredClone(receipt)),
        deviceCustodyCurrent: () => true,
        prepareCloudCopyCollection: vi.fn(() => {
            calls.push("cloud-pin");
        }),
        cloudCopyCollectionCurrent: () => true,
        tick: vi.fn(),
        observations: vi.fn(() => ({
            requiresReopen: false,
            keyringRebuildFailed: false,
            keyringRebuilding: false,
            status: { pending: 0, confirmedThrough: 99, headKnown: 99 },
        })),
        bindCpConnector: vi.fn(),
        bindLogTransport: vi.fn(),
        retireLog: vi.fn(),
    };
    vi.spyOn(AppWasmRuntime, "createDevice").mockImplementation(async () => {
        calls.push("native-create");
        return runtime as unknown as AppWasmRuntime;
    });
    const openNative = vi
        .spyOn(AppWebDeviceKeyCustody.prototype, "openNativeDevice")
        .mockImplementation(async () => {
            calls.push("original-device");
            return structuredClone(custody);
        });
    const register = vi
        .spyOn(AppCpDeviceRegistration.prototype, "register")
        .mockImplementation(async () => {
            calls.push("register");
            return structuredClone(receipt);
        });
    const loadRuntime = vi.fn(async () => {
        calls.push("artifact");
        return Uint8Array.of(0, 97, 115, 109);
    });
    const options = {
        session,
        installation,
        release,
        origin,
        mode,
        signal,
        loadRuntime,
    };
    return {
        calls,
        session,
        installation,
        release,
        receipt,
        custody,
        provider,
        keys,
        noiseStore,
        providerOpen,
        restore,
        runtime,
        openNative,
        register,
        loadRuntime,
        options,
    };
}
describe("owned cloud-copy outcome composition (IDB/native/CP stand-ins, actual WebCrypto)", () => {
    async function collectionFixture() {
        const f = await fixture(),
            host = await AppWebCloudCopyHost.openOriginalDevice(f.options),
            scope = {
                account: f.session.accountId,
                installation: f.session.installationId,
                collection: "22222222-2222-2222-2222-222222222222",
            },
            options = {
                scope,
                collectionCurrent: () => true,
                purpose: "create" as const,
                outcomeMode: "fresh" as const,
                signal: f.options.signal,
                allowLoopbackHttp: true,
            };
        let encrypted: Uint8Array | null = null;
        const store = {
            fenced: false,
            read: vi.fn(async () =>
                encrypted === null ? null : new Uint8Array(encrypted),
            ),
            compareAndSet: vi.fn(
                async (old: Uint8Array | null, next: Uint8Array) => {
                    if (
                        encrypted === null
                            ? old !== null
                            : old === null ||
                              encrypted.length !== old.length ||
                              encrypted.some((v, i) => v !== old[i])
                    )
                        return false;
                    encrypted = new Uint8Array(next);
                    return true;
                },
            ),
            close: vi.fn(() => {
                store.fenced = true;
                f.calls.push("outcome-close");
            }),
        };
        const open = vi
            .spyOn(AppIndexedDbCloudCopyOutcomeStore, "open")
            .mockImplementation(async () => {
                f.calls.push("outcome-open");
                return store as unknown as AppIndexedDbCloudCopyOutcomeStore;
            });
        const item = Uint8Array.of(1, 2, 3),
            d = new TextEncoder().encode("mdbase/v1/chain"),
            input = new Uint8Array(1 + d.length + item.length);
        input[0] = d.length;
        input.set(d, 1);
        input.set(item, 1 + d.length);
        const hash = new Uint8Array(
            await crypto.subtle.digest("SHA-256", input),
        );
        const metadata = {
            operation: {
                ...f.receipt,
                accountId: scope.account,
                collection: scope.collection,
                purpose: options.purpose,
                assetSha256: f.release.assetSha256,
                cpOrigin: f.release.cpOrigin,
                logOrigin: f.release.logOrigin,
            },
            genesisItem: item,
            expectedGenesis: `sha256:${Array.from(hash, (v) => v.toString(16).padStart(2, "0")).join("")}`,
        };
        const bootstrap = vi
            .spyOn(AppCpCloudCopyBootstrap.prototype, "bootstrap")
            .mockImplementation(async function (
                this: AppCpCloudCopyBootstrap,
                o,
            ) {
                f.calls.push("bootstrap");
                const persistence = (
                    this as unknown as {
                        persistence: AppCloudCopyBootstrapPersistence;
                    }
                ).persistence;
                await persistence.pending(metadata.operation, o);
                await persistence.completed(metadata, o);
                return metadata;
            });
        const adopt = vi
            .spyOn(AppCpCloudCopyBootstrap.prototype, "adoptCollection")
            .mockImplementation(() => {
                f.calls.push("adopt");
            });
        return {
            f,
            host,
            options,
            store,
            open,
            metadata,
            bootstrap,
            adopt,
            cipher: () => encrypted,
        };
    }
    async function readableFixture() {
        const c = await collectionFixture();
        await c.host.bootstrapCloudCopy(c.options);
        const sql = { import: vi.fn(), fence: vi.fn(), needsRecovery: false },
            sqlClose = vi.fn(async () => {
                c.f.calls.push("sql-close");
            }),
            openSql = vi.fn(
                async (_input: {
                    scope: Readonly<typeof c.options.scope>;
                    signal: AbortSignal;
                }) => ({
                    sql,
                    opened: "fresh" as const,
                    sqliteVersion: 3053004,
                    close: sqlClose,
                }),
            ),
            sqlOptions = {
                signal: c.options.signal,
                replicaId: c.f.receipt.deviceId,
                endpoint: 37,
                openSql,
            };
        await c.host.openCollectionSql(sqlOptions);
        const reader = {
                query: vi.fn(async () => ({ records: [] })),
                close: vi.fn(),
            },
            connect = vi
                .spyOn(MdbaseClient, "connect")
                .mockResolvedValue(reader as unknown as MdbaseClient),
            facade = { close: vi.fn() },
            attach = vi
                .spyOn(localFacade, "attachAppLocalFacade")
                .mockReturnValue(facade),
            pump = {
                pump: vi.fn(async () => ({ quiet: true })),
                close: vi.fn(async () => {}),
            };
        c.f.runtime.bindLogTransport.mockReturnValue(pump);
        const mint = vi
                .spyOn(AppCpLogAuthority.prototype, "accessToken")
                .mockResolvedValue("fixture-token"),
            transport = vi
                .spyOn(AppCpLogAuthority.prototype, "logTransport")
                .mockReturnValue({
                    endpoint: 37,
                    collection: c.options.scope.collection,
                    isCurrent: () => true,
                    send: async () => new Uint8Array(),
                } as unknown as ReturnType<AppCpLogAuthority["logTransport"]>);
        const channel = {} as MessagePort;
        return {
            ...c,
            sql,
            sqlClose,
            openSql,
            sqlOptions,
            reader,
            connect,
            facade,
            attach,
            pump,
            mint,
            transport,
            channel,
        };
    }
    it("cannot run SQL loader before protected bootstrap completion", async () => {
        const c = await collectionFixture(),
            openSql = vi.fn();
        await expect(
            c.host.openCollectionSql({
                signal: c.options.signal,
                replicaId: c.f.receipt.deviceId,
                endpoint: 37,
                openSql,
            }),
        ).rejects.toThrow();
        expect(openSql).not.toHaveBeenCalled();
        await c.host.close();
    });
    it("SQL callback sees exact frozen original scope/signal; native shuts down before SQL close", async () => {
        const c = await readableFixture();
        expect(c.openSql).toHaveBeenCalledWith({
            scope: c.options.scope,
            signal: c.options.signal,
        });
        expect(Object.isFrozen(c.openSql.mock.calls[0]![0]?.scope)).toBe(true);
        await c.host.close();
        expect(c.f.calls.indexOf("native-close")).toBeLessThan(
            c.f.calls.indexOf("sql-close"),
        );
        expect(c.sql.fence).not.toHaveBeenCalled();
    });
    it("SQL callback drift after opening fences and closes after native without adoption", async () => {
        const c = await collectionFixture();
        await c.host.bootstrapCloudCopy(c.options);
        const sql = { import: vi.fn(), fence: vi.fn(), needsRecovery: false },
            close = vi.fn(async () => {}),
            options = {
                signal: c.options.signal,
                replicaId: c.f.receipt.deviceId,
                endpoint: 37,
                openSql: async () => ({
                    sql,
                    opened: "fresh" as const,
                    sqliteVersion: 3053004,
                    close,
                }),
            };
        options.openSql = async () => {
            options.openSql = async () => ({
                sql,
                opened: "fresh",
                sqliteVersion: 3053004,
                close,
            });
            return { sql, opened: "fresh", sqliteVersion: 3053004, close };
        };
        await expect(c.host.openCollectionSql(options)).rejects.toThrow();
        expect(c.adopt).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
        await c.host.close();
    });
    it("only a typed native Query success admits ONE data facade; zero-pending/head/Hello/completion do not", async () => {
        const c = await readableFixture();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        let resolve!: () => void;
        c.reader.query.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = () => done({ records: [] });
                }),
        );
        const work = c.host.waitForVerifiedRead({ signal: c.options.signal });
        await vi.waitFor(() => expect(c.reader.query).toHaveBeenCalled());
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        resolve();
        await work;
        expect(c.connect.mock.calls[0]![0]).toMatchObject({
            reconnect: false,
            app: { name: "app-local-read-gate" },
        });
        c.host.attachDataFacade(c.channel);
        expect(c.attach).toHaveBeenCalledTimes(1);
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        await c.host.close();
        expect(c.facade.close).toHaveBeenCalledTimes(1);
    });
    it("warm native Query can pass offline without token/transport; unreadable native stays fenced", async () => {
        const c = await readableFixture();
        c.reader.query.mockRejectedValueOnce(
            mdbaseError("unavailable", "not keyed"),
        );
        await expect(
            c.host.waitForVerifiedRead({ signal: c.options.signal }),
        ).rejects.toThrow();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        expect(c.mint).not.toHaveBeenCalled();
        await c.host.waitForVerifiedRead({ signal: c.options.signal });
        c.host.attachDataFacade(c.channel);
        expect(c.f.runtime.close).not.toHaveBeenCalled();
        await c.host.close();
    });
    it("ordinary offline token mint keeps original authority/keys/SQL for explicit foreground retry", async () => {
        const c = await readableFixture();
        c.mint.mockRejectedValueOnce(Error("offline fixture"));
        await expect(
            c.host.startCollectionLog({
                signal: c.options.signal,
                allowLoopbackHttp: true,
            }),
        ).rejects.toThrow("offline");
        expect(c.f.runtime.close).not.toHaveBeenCalled();
        expect(c.sqlClose).not.toHaveBeenCalled();
        await c.host.waitForVerifiedRead({ signal: c.options.signal });
        await c.host.startCollectionLog({
            signal: c.options.signal,
            allowLoopbackHttp: true,
        });
        expect(c.f.runtime.bindCpConnector).toHaveBeenCalledTimes(1);
        expect(c.f.provider.deviceCustodyKek).toHaveBeenCalledTimes(1);
        expect(c.f.runtime.bindLogTransport).toHaveBeenCalledTimes(1);
        await c.host.close();
    });
    it("original log fetch identity cannot be replaced after an offline mint", async () => {
        const c = await readableFixture(),
            fetch = vi.fn() as unknown as typeof globalThis.fetch;
        c.mint.mockRejectedValueOnce(Error("offline"));
        await expect(
            c.host.startCollectionLog({
                signal: c.options.signal,
                fetch,
                allowLoopbackHttp: true,
            }),
        ).rejects.toThrow();
        await expect(
            c.host.startCollectionLog({
                signal: c.options.signal,
                fetch: vi.fn() as unknown as typeof globalThis.fetch,
                allowLoopbackHttp: true,
            }),
        ).rejects.toThrow();
        expect(c.mint).toHaveBeenCalledTimes(1);
        await c.host.close();
    });
    it("available log pump may warm a read gate; only unavailable READ is retried, never a write", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({
            signal: c.options.signal,
            allowLoopbackHttp: true,
        });
        c.reader.query.mockRejectedValueOnce(
            mdbaseError("unavailable", "verified prefix warming"),
        );
        await c.host.waitForVerifiedRead({ signal: c.options.signal });
        expect(c.reader.query).toHaveBeenCalledTimes(2);
        expect(c.pump.pump).toHaveBeenCalledTimes(2);
        expect(c.adopt).toHaveBeenCalledTimes(1);
        await c.host.close();
    });
    it("keyring rebuild failure refuses before Query without SQL reset/fresh retry", async () => {
        const c = await readableFixture();
        c.f.runtime.observations.mockReturnValue({
            requiresReopen: false,
            keyringRebuildFailed: true,
            keyringRebuilding: false,
            status: { pending: 0, confirmedThrough: 99, headKnown: 99 },
        });
        await expect(
            c.host.waitForVerifiedRead({ signal: c.options.signal }),
        ).rejects.toThrow("recovery_required");
        expect(c.reader.query).not.toHaveBeenCalled();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        expect(c.adopt).toHaveBeenCalledTimes(1);
        await c.host.close();
    });
    it("after-read authority drift cannot admit data facade", async () => {
        const c = await readableFixture();
        c.reader.query.mockImplementationOnce(async () => {
            c.f.session.isCurrent = () => true;
            return { records: [] };
        });
        await expect(
            c.host.waitForVerifiedRead({ signal: c.options.signal }),
        ).rejects.toThrow();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        await c.host.close();
    });
    it("READ deadline remains bounded even when log pump hangs; no false facade readiness", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({
            signal: c.options.signal,
            allowLoopbackHttp: true,
        });
        c.pump.pump.mockImplementation(() => new Promise(() => {}));
        await expect(
            c.host.waitForVerifiedRead({
                signal: c.options.signal,
                timeoutMs: 10,
            }),
        ).rejects.toThrow("unavailable");
        expect(c.reader.query).not.toHaveBeenCalled();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        await c.host.close();
    });
    it("unclean native shutdown fences candidate SQL before closing; no physical/Saved inference", async () => {
        const c = await readableFixture();
        c.f.runtime.close.mockResolvedValueOnce(false);
        await c.host.close();
        expect(c.sql.fence).toHaveBeenCalledTimes(1);
        expect(c.sqlClose).toHaveBeenCalledTimes(1);
    });
    it("facade-close failure stays one-shot observable while native and SQL still drain", async () => {
        const c = await readableFixture();
        await c.host.waitForVerifiedRead({ signal: c.options.signal });
        c.host.attachDataFacade(c.channel);
        c.facade.close.mockImplementation(() => {
            throw Error("fixture port shutdown");
        });
        const a = c.host.close(),
            b = c.host.close();
        expect(a === b).toBe(true);
        await expect(a).rejects.toThrow();
        expect(c.f.runtime.close).toHaveBeenCalledTimes(1);
        expect(c.sqlClose).toHaveBeenCalledTimes(1);
    });
    it("same nonexported KEK + concrete outcome adapter precede original cloud pin/bootstrap and SAME-bundle adoption", async () => {
        const c = await collectionFixture();
        expect(await c.host.bootstrapCloudCopy(c.options)).toEqual(c.metadata);
        expect(c.f.calls.slice(-3)).toEqual([
            "outcome-open",
            "cloud-pin",
            "bootstrap",
        ]);
        expect(c.f.provider.deviceCustodyKek).toHaveBeenCalledTimes(1);
        expect(c.store.compareAndSet).toHaveBeenCalledTimes(2);
        expect(c.cipher()!.length).toBeGreaterThan(
            c.metadata.genesisItem.length,
        );
        const signal = c.options.signal,
            sql = { import: vi.fn(), fence: vi.fn(), needsRecovery: false };
        c.host.adoptCloudCopy(
            {
                signal,
                replicaId: c.f.receipt.deviceId,
                endpoint: 37,
                opened: "fresh",
                sqliteVersion: 3053004,
                cloudCopyOptIn: true,
            },
            sql,
        );
        expect(c.adopt).toHaveBeenCalledTimes(1);
        await expect(c.host.bootstrapCloudCopy(c.options)).rejects.toThrow();
        await c.host.close();
        expect(c.f.calls.indexOf("native-close")).toBeLessThan(
            c.f.calls.indexOf("outcome-close"),
        );
    });
    it("foreign collection account rejects BEFORE outcome IO/native pin", async () => {
        const c = await collectionFixture();
        c.options.scope.account = "99999999-9999-9999-9999-999999999999";
        await expect(c.host.bootstrapCloudCopy(c.options)).rejects.toThrow();
        expect(c.open).not.toHaveBeenCalled();
        expect(c.f.runtime.prepareCloudCopyCollection).not.toHaveBeenCalled();
        await c.host.close();
    });
    it("late collection callback drift fences before native/cloud HTTP and closes owned handles", async () => {
        const c = await collectionFixture();
        c.open.mockImplementation(async () => {
            c.options.collectionCurrent = () => true;
            return c.store as unknown as AppIndexedDbCloudCopyOutcomeStore;
        });
        await expect(c.host.bootstrapCloudCopy(c.options)).rejects.toThrow();
        expect(c.f.runtime.prepareCloudCopyCollection).not.toHaveBeenCalled();
        expect(c.bootstrap).not.toHaveBeenCalled();
        expect(c.store.close).toHaveBeenCalledTimes(1);
        expect(c.f.runtime.close).toHaveBeenCalledTimes(1);
    });
    it("outcome versionchange and signal replacement cannot authorize SQL adoption", async () => {
        const c = await collectionFixture();
        await c.host.bootstrapCloudCopy(c.options);
        const sql = { import: vi.fn(), fence: vi.fn(), needsRecovery: false },
            options = {
                signal: new AbortController().signal,
                replicaId: c.f.receipt.deviceId,
                endpoint: 37,
                opened: "fresh" as const,
                sqliteVersion: 3053004,
                cloudCopyOptIn: true as const,
            };
        expect(() => c.host.adoptCloudCopy(options, sql)).toThrow();
        c.store.close();
        expect(() =>
            c.host.adoptCloudCopy(
                { ...options, signal: c.options.signal },
                sql,
            ),
        ).toThrow();
        expect(c.adopt).not.toHaveBeenCalled();
        await c.host.close();
    });
});
describe("production web host device composition ordering (platform/native/CP stand-ins)", () => {
    it("fresh owned identity uses concrete provider/stores once, persists original device before CP, no key export", async () => {
        const f = await fixture(),
            host = await AppWebCloudCopyHost.openOriginalDevice(f.options);
        expect(f.calls).toEqual([
            "provider-open",
            "kek-loan",
            "keys-open",
            "noise-open",
            "noise-restore",
            "artifact",
            "native-create",
            "original-device",
            "register",
        ]);
        expect(f.provider.deviceCustodyKek).toHaveBeenCalledTimes(1);
        expect(f.openNative.mock.calls[0]![1]).toMatchObject({
            mode: "fresh",
            noise: { mode: "fresh" },
            signal: f.options.signal,
        });
        const receipt = host.registeredReceipt();
        expect(receipt).toEqual(f.receipt);
        receipt.signPublicKey.fill(0);
        expect(
            host.registeredReceipt().signPublicKey.every((v) => v === 1),
        ).toBe(true);
        expect(host).not.toHaveProperty("deviceCustodyKek");
        await host.close();
        expect(f.calls.slice(-4)).toEqual([
            "native-close",
            "noise-close",
            "keys-close",
            "provider-close",
        ]);
    });
    it("existing protected original receipt/Noise restores without CP re-registration", async () => {
        const f = await fixture("existing"),
            host = await AppWebCloudCopyHost.openOriginalDevice(f.options);
        expect(f.register).not.toHaveBeenCalled();
        expect(f.runtime.acknowledgeDeviceRegistration).toHaveBeenCalledWith(
            f.receipt,
        );
        expect(f.openNative.mock.calls[0]![1]).toMatchObject({
            mode: "existing",
            noise: { mode: "existing", envelope: f.custody.envelope },
        });
        await host.close();
    });
    it.each([
        "no-ownership",
        "foreign-account",
        "foreign-installation",
        "foreign-environment",
        "strict",
    ])("%s refuses before KEK/store/artifact/native", async (reason) => {
        const f = await fixture();
        if (reason === "no-ownership") f.installation.isCurrent = () => false;
        if (reason === "foreign-account")
            Object.assign(f.installation, {
                scope: {
                    ...f.installation.scope,
                    account: "99999999-9999-9999-9999-999999999999",
                },
            });
        if (reason === "foreign-installation")
            Object.assign(f.installation, {
                scope: {
                    ...f.installation.scope,
                    installation: "99999999-9999-9999-9999-999999999999",
                },
            });
        if (reason === "foreign-environment")
            Object.assign(f.release, { cpOrigin: "https://foreign.test" });
        if (reason === "strict")
            Object.assign(f.session, { approvalMode: "strict" });
        await expect(
            AppWebCloudCopyHost.openOriginalDevice(f.options),
        ).rejects.toThrow();
        expect(f.providerOpen).not.toHaveBeenCalled();
        expect(f.loadRuntime).not.toHaveBeenCalled();
    });
    it.each(["absent-existing", "pending-registration", "existing-on-fresh"])(
        "%s preserves storage/refuses before native or HTTP",
        async (reason) => {
            const f = await fixture(
                reason === "existing-on-fresh" ? "fresh" : "existing",
            );
            f.restore.mockResolvedValue(
                reason === "absent-existing"
                    ? null
                    : {
                          envelope: f.custody.envelope,
                          receipt:
                              reason === "pending-registration"
                                  ? null
                                  : f.receipt,
                          privateEnrolMarker: null,
                      },
            );
            await expect(
                AppWebCloudCopyHost.openOriginalDevice(f.options),
            ).rejects.toMatchObject({ reason: "recovery_required" });
            expect(f.openNative).not.toHaveBeenCalled();
            expect(f.register).not.toHaveBeenCalled();
            expect(f.provider.close).toHaveBeenCalled();
        },
    );
    it.each([
        "source-field",
        "source-callback",
        "ownership-callback",
        "release-root",
        "signal",
    ])("late %s mutation fences before key loan", async (reason) => {
        const f = await fixture(),
            original = f.providerOpen.getMockImplementation()!,
            controller = new AbortController();
        if (reason === "signal") f.options.signal = controller.signal;
        f.providerOpen.mockImplementation(async (options) => {
            const provider = await original(options);
            if (reason === "source-field")
                Object.assign(f.session, {
                    deviceId: "99999999-9999-9999-9999-999999999999",
                });
            if (reason === "source-callback")
                Object.assign(f.session, { isCurrent: () => true });
            if (reason === "ownership-callback")
                f.installation.isCurrent = () => true;
            if (reason === "release-root") f.release.trustedRoots[0]!.fill(0);
            if (reason === "signal") {
                controller.abort();
                f.options.signal = new AbortController().signal;
            }
            return provider;
        });
        await expect(
            AppWebCloudCopyHost.openOriginalDevice(f.options),
        ).rejects.toMatchObject({ reason: "fenced" });
        expect(f.provider.deviceCustodyKek).not.toHaveBeenCalled();
        expect(f.provider.close).toHaveBeenCalled();
        expect(f.loadRuntime).not.toHaveBeenCalled();
    });
    it("failure after native creation closes/fences without regeneration; close is single-shot", async () => {
        const f = await fixture();
        f.openNative.mockRejectedValue(Error("cipher/key uncertainty"));
        await expect(
            AppWebCloudCopyHost.openOriginalDevice(f.options),
        ).rejects.toMatchObject({ reason: "unavailable" });
        expect(f.openNative).toHaveBeenCalledTimes(1);
        expect(f.runtime.close).toHaveBeenCalledTimes(1);
        expect(f.register).not.toHaveBeenCalled();
        const g = await fixture(),
            host = await AppWebCloudCopyHost.openOriginalDevice(g.options);
        const a = host.close(),
            b = host.close();
        expect(a).toBe(b);
        expect(() => host.registeredReceipt()).toThrow();
        await a;
        expect(g.runtime.close).toHaveBeenCalledTimes(1);
    });
});
describe("SAME installation-device host composition (platform/native/flow stand-ins)", () => {
    async function installationFixture(mode: "fresh" | "existing" = "fresh", completed = false) {
        const f = await fixture(mode);
        let state: AppInstallationSignInView["state"] = completed ? "paired" : "account_confirmed";
        const view = () => ({state} as AppInstallationSignInView);
        const pending = vi.spyOn(AppWebNoiseCustody.prototype, "pending").mockImplementation(async () => {f.calls.push("protected-noise-pending");});
        const registered = vi.spyOn(AppWebNoiseCustody.prototype, "registered").mockImplementation(async () => {f.calls.push("protected-receipt");});
        if (mode === "existing" && !completed) f.restore.mockResolvedValue({envelope: f.custody.envelope, receipt: null, privateEnrolMarker: null});
        const signIn = {
            confirmedHostSession: vi.fn(() => {f.calls.push("confirmed-selection"); return f.session;}),
            prepareOriginalDevice: vi.fn(async () => {f.calls.push("protected-original-attempt"); return {mode, pin: {...f.session, installationOwned: f.installation.isCurrent}};}),
            view,
            attest: vi.fn(async (args: {runtime: AppWasmRuntime; custody: typeof f.custody; persistence: AppWebNoiseCustody}) => {
                expect(args.runtime).toBe(f.runtime); expect(args.custody).toEqual(f.custody);
                expect(args.persistence).toBeInstanceOf(AppWebNoiseCustody);
                f.calls.push("fixed-attest"); state = "awaiting_approval"; return view();
            }),
            acknowledge: vi.fn(async (args: {runtime: AppWasmRuntime; custody: typeof f.custody; persistence: AppWebNoiseCustody}) => {
                if (state !== "paired") throw Error("credential not protected");
                expect(args.runtime).toBe(f.runtime); expect(args.custody).toEqual(f.custody);
                await args.persistence.registered(f.receipt, {signal: f.options.signal});
                args.runtime.acknowledgeDeviceRegistration(f.receipt); return f.receipt;
            }),
        };
        const options = {...f.options, signIn: signIn as unknown as AppProtectedInstallationSignIn};
        return {...f, signIn, options, pending, registered, paired: () => {state = "paired";}};
    }
    it("commits attempt before custody, protects original Noise and gates collection before pairing", async () => {
        const f = await installationFixture(), host = await AppWebCloudCopyHost.openInstallationDevice(f.options);
        expect(f.calls).toEqual(["confirmed-selection", "protected-original-attempt", "provider-open", "kek-loan", "keys-open", "noise-open", "noise-restore", "artifact", "native-create", "original-device", "protected-noise-pending"]);
        expect(() => host.registeredReceipt()).toThrow();
        await expect(host.bootstrapCloudCopy({scope: {account: f.session.accountId, installation: f.session.installationId, collection: "22222222-2222-2222-2222-222222222222"}, collectionCurrent: () => true, purpose: "create", outcomeMode: "fresh", signal: f.options.signal})).rejects.toThrow("binding");
        expect(f.register).not.toHaveBeenCalled(); expect(f.runtime.acknowledgeDeviceRegistration).not.toHaveBeenCalled();
        await host.attestInstallation();
        await expect(host.completeInstallationSignIn()).rejects.toThrow("credential not protected");
        f.paired(); expect(await host.completeInstallationSignIn()).toEqual(f.receipt);
        expect(f.calls.slice(-2)).toEqual(["protected-receipt", "ack"]);
        expect(f.openNative).toHaveBeenCalledTimes(1); expect(f.providerOpen).toHaveBeenCalledTimes(1);
        expect(host.registeredReceipt()).toEqual(f.receipt); expect(f.register).not.toHaveBeenCalled();
        await host.close();
    });
    it("partial original registration restores existing Noise without requiring a completed receipt", async () => {
        const f = await installationFixture("existing"), host = await AppWebCloudCopyHost.openInstallationDevice(f.options);
        expect(f.openNative.mock.calls[0]![1]).toMatchObject({mode: "existing", noise: {mode: "existing", envelope: f.custody.envelope}});
        expect(f.register).not.toHaveBeenCalled(); expect(f.signIn.acknowledge).not.toHaveBeenCalled();
        await host.attestInstallation(); f.paired(); await host.completeInstallationSignIn();
        expect(f.openNative).toHaveBeenCalledTimes(1); await host.close();
    });
    it("completed restore performs only protected receipt/native ACK, no attest or controller register", async () => {
        const f = await installationFixture("existing", true), host = await AppWebCloudCopyHost.openInstallationDevice(f.options);
        expect(f.signIn.attest).not.toHaveBeenCalled(); expect(f.register).not.toHaveBeenCalled();
        expect(f.signIn.acknowledge).toHaveBeenCalledTimes(1); expect(host.registeredReceipt()).toEqual(f.receipt);
        expect(f.calls.slice(-2)).toEqual(["protected-receipt", "ack"]); await host.close();
    });
    it.each(["missing-existing", "receipt-without-credential", "existing-on-fresh"])("%s preserves original storage and refuses without registration", async reason => {
        const f = await installationFixture(reason === "existing-on-fresh" ? "fresh" : "existing");
        f.restore.mockResolvedValue(reason === "missing-existing" ? null : {envelope: f.custody.envelope, receipt: f.receipt, privateEnrolMarker: null});
        await expect(AppWebCloudCopyHost.openInstallationDevice(f.options)).rejects.toMatchObject({reason: "recovery_required"});
        expect(f.register).not.toHaveBeenCalled(); expect(f.signIn.acknowledge).not.toHaveBeenCalled(); expect(f.provider.close).toHaveBeenCalled();
        if (reason !== "receipt-without-credential") expect(f.openNative).not.toHaveBeenCalled();
    });
    it("unconfirmed selection or foreign ownership refuses before attempt/provider", async () => {
        const f = await installationFixture(); f.signIn.confirmedHostSession.mockImplementation(() => {throw Error("account_confirmation_required");});
        await expect(AppWebCloudCopyHost.openInstallationDevice(f.options)).rejects.toThrow("account_confirmation_required");
        expect(f.signIn.prepareOriginalDevice).not.toHaveBeenCalled(); expect(f.providerOpen).not.toHaveBeenCalled();
        const g = await installationFixture(); g.installation.isCurrent = () => false;
        await expect(AppWebCloudCopyHost.openInstallationDevice(g.options)).rejects.toThrow("fenced");
        expect(g.signIn.prepareOriginalDevice).not.toHaveBeenCalled(); expect(g.providerOpen).not.toHaveBeenCalled();
    });
    it("late ownership change after committed attempt fences before custody", async () => {
        const f = await installationFixture(); f.signIn.prepareOriginalDevice.mockImplementation(async () => {f.installation.isCurrent = () => true; return {mode: "fresh", pin: {...f.session, installationOwned: f.installation.isCurrent}};});
        await expect(AppWebCloudCopyHost.openInstallationDevice(f.options)).rejects.toThrow("fenced"); expect(f.providerOpen).not.toHaveBeenCalled();
    });
    it("completed sign-in continues cloud bootstrap on SAME native owner under collection ownership", async () => {
        const f = await installationFixture(), host = await AppWebCloudCopyHost.openInstallationDevice(f.options);
        await host.attestInstallation(); f.paired(); await host.completeInstallationSignIn();
        const store = {fenced: false, read: vi.fn(async () => null), compareAndSet: vi.fn(async () => true), close: vi.fn()};
        const open = vi.spyOn(AppIndexedDbCloudCopyOutcomeStore, "open").mockResolvedValue(store as unknown as AppIndexedDbCloudCopyOutcomeStore);
        const bootstrap = vi.spyOn(AppCpCloudCopyBootstrap.prototype, "bootstrap").mockResolvedValue({collection: "22222222-2222-2222-2222-222222222222"} as unknown as Awaited<ReturnType<AppCpCloudCopyBootstrap["bootstrap"]>>);
        const options = {scope: {account: f.session.accountId, installation: f.session.installationId, collection: "22222222-2222-2222-2222-222222222222"}, collectionCurrent: () => false, purpose: "create" as const, outcomeMode: "fresh" as const, signal: f.options.signal, allowLoopbackHttp: true};
        await expect(host.bootstrapCloudCopy(options)).rejects.toThrow("fenced");
        expect(open).not.toHaveBeenCalled(); expect(f.runtime.prepareCloudCopyCollection).not.toHaveBeenCalled();
        options.collectionCurrent = () => true;
        await host.bootstrapCloudCopy(options);
        expect(open).toHaveBeenCalledTimes(1); expect(f.runtime.prepareCloudCopyCollection).toHaveBeenCalledTimes(1); expect(bootstrap).toHaveBeenCalledTimes(1);
        expect(f.openNative).toHaveBeenCalledTimes(1); expect(f.providerOpen).toHaveBeenCalledTimes(1); expect(f.register).not.toHaveBeenCalled();
        await host.close(); expect(store.close).toHaveBeenCalled();
    });
    it("lost attestation reply retains SAME owner for explicit retry without key re-open", async () => {
        const f = await installationFixture(), host = await AppWebCloudCopyHost.openInstallationDevice(f.options);
        f.signIn.attest.mockRejectedValueOnce(Error("outcome_unknown")); await expect(host.attestInstallation()).rejects.toThrow("outcome_unknown");
        await host.attestInstallation(); f.paired(); await host.completeInstallationSignIn();
        expect(f.openNative).toHaveBeenCalledTimes(1); expect(f.register).not.toHaveBeenCalled();
        await host.close(); await expect(host.attestInstallation()).rejects.toThrow("fenced");
    });
});
