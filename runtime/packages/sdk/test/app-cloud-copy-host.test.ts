import { afterEach, describe, expect, it, vi } from "vitest";
import { TimersApi } from "../src/timers.js";
import { appTimerPortClient } from "../src/app-host/timer-port.js";
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
import type { SyncStatus } from "../src/wire.js";
import { AppLogPump, type AppLogCall, type AppLogRuntime, type AppLogTransport } from "../src/app-host/log-pump.js";
import { encode, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { appServerProblem } from "../src/app-host/cp-problem.js";
import { AppHttpLogTransport } from "../src/app-host/http-log.js";
import { IDBFactory } from "fake-indexeddb";
import { createAppWebCollectionAdapter } from "../src/app-host/web-collection.js";
import * as collectionSql from "../src/app-storage/collection-sql.js";
import { AppWebSignInSession } from "../src/app-host/web-sign-in-session.js";
import { AppProtectedInstallationSignIn as ProtectedSignIn } from "../src/app-host/installation-sign-in.js";
import * as ownership from "../src/app-host/owner.js";
import { AppCpLogAuthority } from "../src/app-host/cp-authority.js";
import * as localFacade from "../src/app-host/local-facade.js";
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function fixture(mode: "fresh" | "existing" = "fresh") {
    const calls: string[] = [],
        origin = "https://app.example.test",
        controller = new AbortController(),
        signal = controller.signal;
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
        connectorBearer: vi.fn(async () => "ct_fixture-bearer"),
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
            status: { mode: "synced", connection: "online", incidents: [], pending: 0, confirmedThrough: 99, headKnown: 99, holds: 0, unresolved: 0 } as SyncStatus,
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
        controller,
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
    async function collectionFixture(purpose: "create" | "join" = "create") {
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
                purpose,
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
            facade = { close: vi.fn(), resourceSetup: { assess: vi.fn(), apply: vi.fn() } },
            attach = vi
                .spyOn(localFacade, "attachAppLocalFacade")
                .mockReturnValue(facade),
            pump = {
                readProgress: 0,
                responseProgress: vi.fn(() => [] as {id: number; bytes: number}[]),
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
    it.each(["direct", "factory"] as const)("public session %s openCollection can bootstrap using SDK child cancellation", async path => {
        const c = await collectionFixture("join"); await c.host.close();
        const requestId = "77777777-7777-4777-8777-777777777777";
        const flow = {
            view: () => ({state: "paired", requestId, collectionSelection: null, collectionIds: [c.options.scope.collection]}),
            start: vi.fn(async () => ({state: "paired"})),
            confirmedSelection: () => ({accountId: c.options.scope.account, installationId: c.options.scope.installation}),
            collectionConsentView: () => null,
            listApprovedCollections: async () => [{collectionId: c.options.scope.collection, displayName: "Fixture", role: "owner"}],
            close: vi.fn(async () => {}),
        };
        vi.spyOn(ProtectedSignIn, "open").mockResolvedValue(flow as unknown as ProtectedSignIn);
        vi.spyOn(ownership, "acquireAppInstallationLease").mockResolvedValue({release: async () => {}});
        vi.spyOn(ownership, "acquireAppReplicaLease").mockResolvedValue({release: async () => {}});
        let parentSignal!: AbortSignal, childSignal!: AbortSignal, actualHost!: AppWebCloudCopyHost;
        vi.spyOn(AppWebCloudCopyHost, "openInstallationDevice").mockImplementation(async input => {
            parentSignal = input.signal;
            actualHost = await AppWebCloudCopyHost.openOriginalDevice({...c.f.options, signal: input.signal});
            return actualHost;
        });
        let handedOff = false;
        // Factory, SDK session, host, protected persistence and WebCrypto are real;
        // native/CP, platform IDB and SQL are declared component stand-ins.
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.spyOn(collectionSql, "createAppCollectionSql").mockReturnValue(async () => ({
            sql: {import: vi.fn(), fence: vi.fn(), needsRecovery: false}, opened: "fresh", sqliteVersion: 3053004, close: async () => {},
        }));
        vi.spyOn(MdbaseClient, "connect").mockResolvedValue({query: async () => ({records: []}), close() {}} as unknown as MdbaseClient);
        vi.spyOn(localFacade, "attachAppLocalFacade").mockReturnValue({close() {}, resourceSetup: {assess: vi.fn(), apply: vi.fn()}});
        c.f.runtime.bindLogTransport.mockReturnValue({pump: async () => ({quiet: true}), close: async () => {}});
        vi.spyOn(AppCpLogAuthority.prototype, "accessToken").mockResolvedValue("fixture-token");
        vi.spyOn(AppCpLogAuthority.prototype, "logTransport").mockReturnValue({
            endpoint: 0, collection: c.options.scope.collection, isCurrent: () => true,
            send: async () => new Uint8Array(),
        } as unknown as ReturnType<AppCpLogAuthority["logTransport"]>);
        const factory = createAppWebCollectionAdapter({
            allowLoopbackHttp: true,
            joinDatabaseName: "fixture.join", setupJournal: {databaseName: "fixture.setup", applicationNamespace: "fixture", appOrigin: c.f.options.origin, cpOrigin: c.f.release.cpOrigin},
            sql: {wasmSha256: "00".repeat(32), maxWasmBytes: 1100000, loadWasm: async () => new Uint8Array(1), initialize: async () => ({})},
            handoff: () => {handedOff = true;},
        });
        const session = new AppWebSignInSession<unknown>({
            appId: "fixture-app", appName: "Fixture", environment: "production",
            origin: c.f.options.origin, cpOrigin: c.f.release.cpOrigin,
            release: {...c.f.release, environment: "production"}, signal: c.f.options.signal, locks: undefined,
            loadRuntime: c.f.loadRuntime, openPortal: () => ({navigate() {}, close() {}}),
            openCollection: async input => {
                childSignal = input.signal;
                expect(childSignal).not.toBe(parentSignal);
                if (path === "factory") return factory(input);
                await input.host.bootstrapCloudCopy({...c.options, scope: input.scope, signal: input.signal});
                return {state: "setup_required", connection: {fixture: true}, close: async () => {}};
            },
        });
        await session.start();
        expect(session.snapshot().status).toBe("setup_required");
        expect(c.bootstrap).toHaveBeenCalledOnce(); expect(c.f.openNative).toHaveBeenCalledTimes(2);
        expect(actualHost.registeredReceipt()).toEqual(c.f.receipt);
        expect(handedOff).toBe(path === "factory");
        await session.close(); expect(childSignal.aborted).toBe(true);
    });
    it.each(["host", "caller"] as const)("%s cancellation before bootstrap refuses before outcome IO or native preparation", async which => {
        const c = await collectionFixture(), caller = new AbortController();
        (which === "host" ? c.f.controller : caller).abort();
        await expect(c.host.bootstrapCloudCopy({...c.options, signal: caller.signal})).rejects.toMatchObject({reason: "fenced"});
        expect(c.open).not.toHaveBeenCalled(); expect(c.bootstrap).not.toHaveBeenCalled();
        expect(c.f.runtime.prepareCloudCopyCollection).not.toHaveBeenCalled(); await c.host.close();
    });
    it.each(["host", "caller"] as const)("%s cancellation during bootstrap cannot deliver late metadata or admit adoption", async which => {
        const c = await collectionFixture(), caller = new AbortController();
        const original = c.bootstrap.getMockImplementation()!;
        let internal!: AbortSignal;
        c.bootstrap.mockImplementation(async function (this: AppCpCloudCopyBootstrap, input) {
            internal = input.signal;
            const metadata = await original.call(this, input);
            (which === "host" ? c.f.controller : caller).abort();
            return metadata;
        });
        await expect(c.host.bootstrapCloudCopy({...c.options, signal: caller.signal})).rejects.toMatchObject({reason: "fenced"});
        expect(internal.aborted).toBe(true); expect(c.cipher()).not.toBeNull();
        expect(c.bootstrap).toHaveBeenCalledOnce(); expect(c.adopt).not.toHaveBeenCalled();
        await c.host.close(); expect(c.f.runtime.close).toHaveBeenCalledOnce();
    });
    it("an aborted original collection signal cannot be replaced by a fresh caller signal", async () => {
        const c = await collectionFixture(), caller = new AbortController();
        await c.host.bootstrapCloudCopy({...c.options, signal: caller.signal}); caller.abort();
        expect(() => c.host.adoptCloudCopy({signal: new AbortController().signal,
            replicaId: c.f.receipt.deviceId, endpoint: 37, opened: "fresh", sqliteVersion: 3053004, cloudCopyOptIn: true},
            {import: vi.fn(), fence: vi.fn(), needsRecovery: false})).toThrow();
        expect(c.adopt).not.toHaveBeenCalled(); await c.host.close();
    });
    it("per-call SQL cancellation propagates internally and retains late-handle cleanup without adoption", async () => {
        const c = await collectionFixture(); await c.host.bootstrapCloudCopy(c.options);
        const caller = new AbortController(), close = vi.fn(async () => {});
        let internal!: AbortSignal, finish!: () => void;
        const pending = c.host.openCollectionSql({signal: caller.signal, replicaId: c.f.receipt.deviceId, endpoint: 37,
            openSql: async input => {
                internal = input.signal;
                await new Promise<void>(resolve => {finish = resolve;});
                return {sql: {import: vi.fn(), fence: vi.fn(), needsRecovery: false}, opened: "fresh", sqliteVersion: 3053004, close};
            },
        });
        const rejected = expect(pending).rejects.toMatchObject({reason: "fenced"});
        caller.abort(); expect(internal.aborted).toBe(true); finish(); await rejected;
        expect(c.adopt).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    });
    it("a shared log waiter must retain its own caller fence without a second mint", async () => {
        const c = await readableFixture(), first = new AbortController(), second = new AbortController();
        let finish!: () => void;
        c.mint.mockImplementationOnce(async () => {
            await new Promise<void>(resolve => {finish = resolve;}); return "fixture-token";
        });
        const original = c.host.startCollectionLog({signal: first.signal});
        const waiter = c.host.startCollectionLog({signal: second.signal});
        const rejected = expect(waiter).rejects.toMatchObject({reason: "fenced"});
        second.abort(); finish(); await original; await rejected;
        expect(c.mint).toHaveBeenCalledOnce(); await c.host.close();
    });
    it("absent timer consent retains the original collection factory without requiring or creating Worker timer IPC", async () => {
        const c = await readableFixture(), child = new AbortController();
        const request = vi.fn(async () => Response.json({namespace: "reminders", timers: []}));
        await c.host.startCollectionLog({signal: c.options.signal, fetch: request});
        await c.host.waitForVerifiedRead({signal: c.options.signal});
        vi.stubGlobal("WorkerGlobalScope", undefined);
        const channel = vi.spyOn(globalThis, "MessageChannel");
        expect(c.host.openTimersPort({scope: c.options.scope, generation: "55555555-5555-4555-8555-555555555555", signal: child.signal})).toBeNull();
        expect(channel).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
        expect(c.f.session.connectorBearer).not.toHaveBeenCalled(); await c.host.close();
    });
    it("a drive keeps turning while ticks queue log calls, then stops; app writes ask for a drive", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal, fetch: vi.fn(async () => Response.json({}))}); await c.host.waitForVerifiedRead({signal: c.options.signal});
        // Turns 1 and 2 send calls (a reply's follow-up step only a tick queues); turn 3 is quiet.
        let sent = 0, turn = 0;
        Object.defineProperty(c.pump, "callsSent", {get: () => sent});
        c.pump.pump.mockImplementation(async () => { if (++turn <= 2) sent++; return {quiet: true}; });
        c.f.runtime.tick.mockClear(); c.pump.pump.mockClear();
        await c.host.driveCollection({signal: c.options.signal});
        expect(c.pump.pump).toHaveBeenCalledTimes(3); expect(c.f.runtime.tick).toHaveBeenCalledTimes(3);
        const work = vi.fn(); c.host.onLogWork(work);
        c.host.attachDataFacade(c.channel);
        const hint = c.attach.mock.calls.at(-1)![3]!; hint();
        expect(work).toHaveBeenCalledOnce();
        await c.host.close();
    });
    async function timerFixture() {
        vi.stubGlobal("WorkerGlobalScope",class {static [Symbol.hasInstance](value:unknown){return value===globalThis;}});
        const c=await readableFixture(),child=new AbortController(),generation="55555555-5555-4555-8555-555555555555";
        const consent={requestId:"66666666-6666-4666-8666-666666666666",approved:true,grants:[{grantId:"77777777-7777-4777-8777-777777777777",collectionId:c.options.scope.collection,declarationDigest:"ab".repeat(32)}]};
        Object.assign(c.f.session,{timerConsent:()=>consent});vi.mocked(c.f.session.connectorBearer).mockResolvedValue(`idev_${"a".repeat(43)}`);
        const request=vi.fn(async()=>Response.json({namespace:"reminders",timers:[]}));
        await c.host.startCollectionLog({signal:c.options.signal,fetch:request});await c.host.waitForVerifiedRead({signal:c.options.signal});
        const options={scope:c.options.scope,generation,signal:child.signal};
        return {...c,consent,request,child,timerOptions:options};
    }
    it("constructs native timer IPC only from the actual chosen original receipt in SAME Worker/scope/child lifetime",async()=>{
        const c=await timerFixture(),opened=c.host.openTimersPort(c.timerOptions)!;
        const api=new TimersApi(appTimerPortClient(opened.port,c.timerOptions,{signal:c.child.signal,onClose:()=>{}}));
        expect(await api.list("reminders")).toEqual({namespace:"reminders",timers:[]});
        expect(c.f.session.connectorBearer).toHaveBeenCalledWith({signal:c.options.signal});
        expect(c.request.mock.calls[0]).toEqual([`https://cp.example.test/v1/next/collections/${c.options.scope.collection}/background-grants/${c.consent.grants[0]!.grantId}/timers/reminders`,expect.objectContaining({method:"GET",credentials:"omit",redirect:"error"})]);
        expect(Object.keys(opened).sort()).toEqual(["close","port"]);api.close();await opened.close();await c.host.close();
    });
    it.each(["declined","other_collection","worker","wrong_scope"])("native timer constructor refuses %s without a credential loan",async variant=>{
        const c=await timerFixture();
        if(variant==="declined")c.consent.approved=false;
        if(variant==="other_collection")c.consent.grants[0]!.collectionId="88888888-8888-4888-8888-888888888888";
        if(variant==="worker")vi.stubGlobal("WorkerGlobalScope",undefined);
        if(variant==="wrong_scope")c.timerOptions.scope={...c.options.scope,collection:"88888888-8888-4888-8888-888888888888"};
        if(variant==="declined"||variant==="other_collection")expect(c.host.openTimersPort(c.timerOptions)).toBeNull();
        else expect(()=>c.host.openTimersPort(c.timerOptions)).toThrow("binding");
        expect(c.request).not.toHaveBeenCalled();expect(c.f.session.connectorBearer).not.toHaveBeenCalled();await c.host.close();
    });
    it("fences old timer port on fresh consent and drains actual IPC/HTTP BEFORE native host stop",async()=>{
        const c=await timerFixture();let deliver!:(response:Response)=>void;
        c.request.mockImplementation(async()=>new Promise(resolve=>{deliver=resolve;}));
        const opened=c.host.openTimersPort(c.timerOptions)!,api=new TimersApi(appTimerPortClient(opened.port,c.timerOptions,{signal:c.child.signal,onClose:()=>{}}));
        const list=api.list("reminders");await vi.waitFor(()=>expect(c.request).toHaveBeenCalledOnce());
        const rejected=expect(list).rejects.toMatchObject({code:"cancelled"});
        const close=c.host.close();await rejected;expect(c.f.runtime.close).not.toHaveBeenCalled();
        deliver(Response.json({namespace:"reminders",timers:[]}));await close;expect(c.f.runtime.close).toHaveBeenCalledOnce();api.close();
    });
    it("never adopts a changed declaration/grant snapshot into an existing port",async()=>{
        const c=await timerFixture(),opened=c.host.openTimersPort(c.timerOptions)!;
        const api=new TimersApi(appTimerPortClient(opened.port,c.timerOptions,{signal:c.child.signal,onClose:()=>{}}));
        c.consent.grants[0]!.grantId="88888888-8888-4888-8888-888888888888";
        await expect(api.list("reminders")).rejects.toMatchObject({code:"unauthenticated"});expect(c.request).not.toHaveBeenCalled();
        api.close();await opened.close();await c.host.close();
    });
    it("people metadata requires adopted collection and an already pinned CP transport", async () => {
        const c = await collectionFixture();
        expect(() => c.host.peopleAuthority()).toThrow("fenced");
        await c.host.bootstrapCloudCopy(c.options);
        expect(() => c.host.peopleAuthority()).toThrow("binding");
        await c.host.close();
        const r = await readableFixture();
        expect(() => r.host.peopleAuthority()).toThrow("binding");
        await r.host.startCollectionLog({ signal: r.options.signal });
        expect(r.host.peopleAuthority().collection).toBe(r.options.scope.collection);
        await r.host.close();
    });
    it("people factory exposes only one frozen read-only view using the original CP credential and transport", async () => {
        const c = await readableFixture();
        const request = vi.fn(async () => Response.json({ issuer: c.f.session.cpOrigin, subject: c.f.session.accountId, name: "Person" }));
        await c.host.startCollectionLog({ signal: c.options.signal, fetch: request });
        const metadata = c.host.peopleAuthority();
        expect(c.host.peopleAuthority()).toBe(metadata);
        expect(Object.isFrozen(metadata)).toBe(true);
        expect(Object.keys(metadata).sort()).toEqual(["collection", "isCurrent", "request"]);
        expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
        expect(await metadata.request("identity")).toMatchObject({ subject: c.f.session.accountId });
        expect(c.f.session.connectorBearer).toHaveBeenCalledWith({ signal: c.options.signal });
        expect(request).toHaveBeenCalledWith(
            `${c.f.session.cpOrigin}/v1/authorities/${c.options.scope.collection}/identity?device_id=${c.f.session.deviceId}`,
            expect.objectContaining({ method: "GET", headers: { authorization: "Bearer ct_fixture-bearer" }, credentials: "omit", redirect: "error" }),
        );
        await c.host.close();
        expect(metadata.isCurrent()).toBe(false);
        await expect(metadata.request("members")).rejects.toMatchObject({ code: "unauthenticated" });
        expect(() => c.host.peopleAuthority()).toThrow("fenced");
        expect(request).toHaveBeenCalledTimes(1);
    });
    it.each(["collection", "session", "ownership", "origin", "outcome"] as const)("people view refuses %s lifetime drift before HTTP", async (drift) => {
        const c = await readableFixture();
        const request = vi.fn(async () => Response.json({}));
        await c.host.startCollectionLog({ signal: c.options.signal, fetch: request });
        const metadata = c.host.peopleAuthority();
        switch (drift) {
            case "collection": c.options.scope.collection = "33333333-3333-3333-3333-333333333333"; break;
            case "session": c.f.session.isCurrent = () => true; break;
            case "ownership": c.f.installation.isCurrent = () => true; break;
            case "origin": vi.stubGlobal("location", { origin: "https://other.example.test" }); break;
            case "outcome": c.store.close(); break;
        }
        expect(metadata.isCurrent()).toBe(false);
        await expect(metadata.request("identity")).rejects.toMatchObject({ code: "unauthenticated" });
        expect(request).not.toHaveBeenCalled();
        await c.host.close();
    });
    it("host close aborts people HTTP before native drain and refuses a late reply", async () => {
        const c = await readableFixture();
        let deliver!: (response: Response) => void;
        let httpSignal: AbortSignal | undefined;
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            httpSignal = init?.signal ?? undefined;
            return new Promise<Response>(resolve => { deliver = resolve; });
        });
        await c.host.startCollectionLog({ signal: c.options.signal, fetch: request });
        const metadata = c.host.peopleAuthority();
        const pending = metadata.request("identity");
        const rejected = expect(pending).rejects.toMatchObject({ code: "unauthenticated" });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        let drained!: () => void;
        c.f.runtime.close.mockImplementationOnce(() => {
            c.f.calls.push("native-close");
            return new Promise<boolean>(resolve => { drained = () => resolve(true); });
        });
        const closing = c.host.close();
        expect(httpSignal?.aborted).toBe(true);
        expect(c.sqlClose).not.toHaveBeenCalled();
        deliver(Response.json({ issuer: c.f.session.cpOrigin, subject: c.f.session.accountId, name: "Late" }));
        await rejected;
        drained();
        await closing;
        expect(c.f.calls.indexOf("native-close")).toBeLessThan(c.f.calls.indexOf("sql-close"));
    });
    it("late people reply cannot cross a changed collection lifetime", async () => {
        const c = await readableFixture();
        const request = vi.fn(async () => {
            c.options.scope.collection = "33333333-3333-3333-3333-333333333333";
            return Response.json({ issuer: c.f.session.cpOrigin, subject: c.f.session.accountId, name: "Late" });
        });
        await c.host.startCollectionLog({ signal: c.options.signal, fetch: request });
        await expect(c.host.peopleAuthority().request("identity")).rejects.toMatchObject({ code: "unauthenticated" });
        await c.host.close();
    });
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
    it("SQL callback sees frozen original scope and composed signal; native shuts down before SQL close", async () => {
        const c = await readableFixture();
        expect(c.openSql).toHaveBeenCalledWith({
            scope: c.options.scope,
            signal: expect.any(AbortSignal),
        });
        expect(c.openSql.mock.calls[0]![0].signal.aborted).toBe(false);
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
        expect(c.host.attachDataFacade(c.channel)).toBe(c.facade.resourceSetup);
        expect(c.attach).toHaveBeenCalledTimes(1);
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        await c.host.close();
        expect(c.facade.close).toHaveBeenCalledTimes(1);
    });
    it.each([true, false])("first sync (cold: %s) permits a forty-second multi-RPC pump making accepted prefix progress", async cold => {
        const c = await readableFixture();
        let confirmed = 0, issued = 0, outcome = "opening";
        const observation = c.f.runtime.observations();
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {
            ...observation.status, confirmedThrough: confirmed, headKnown: 16,
        }}));
        const runtime: AppLogRuntime = {
            takeLogCalls: () => confirmed < 16 ? [0, 1].map((): AppLogCall => ({endpoint: 37, frame: encode(new Map<number, CborValue>([
                [0, 0], [1, ++issued], [2, "read"], [3, new Map<number, CborValue>([[0, uuidToBytes(c.options.scope.collection)], [1, confirmed]])],
            ]))})) : [],
            acceptLogReply: () => {confirmed++; return true;}, logNoResponse: vi.fn(), retireLog: vi.fn(),
        };
        const transport: AppLogTransport = {endpoint: 37, collection: c.options.scope.collection, isCurrent: () => true,
            send: vi.fn<AppLogTransport["send"]>((_call, {signal}) => new Promise<Uint8Array>((resolve, reject) => {
                const stop = () => {clearTimeout(timer); reject(Error("aborted"));};
                const timer = setTimeout(() => {signal.removeEventListener("abort", stop); resolve(Uint8Array.of(1));}, 5_000);
                signal.addEventListener("abort", stop, {once: true});
            })),
        };
        const pump = new AppLogPump(runtime, transport, {endpoint: 37, collection: c.options.scope.collection});
        c.f.runtime.bindLogTransport.mockReturnValue(pump);
        await c.host.startCollectionLog({signal: c.options.signal});
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold}).then(
            () => {outcome = "readable";}, error => {outcome = error.reason ?? "failed";});
        try {
            await vi.advanceTimersByTimeAsync(20_000);
            expect(confirmed).toBeGreaterThan(0);
            expect(outcome).toBe("opening");
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            await vi.advanceTimersByTimeAsync(20_001); await work;
            expect(outcome).toBe("readable");
            expect(transport.send).toHaveBeenCalledTimes(16);
            expect(c.reader.query).toHaveBeenCalledOnce();
            expect(c.mint).toHaveBeenCalledOnce(); expect(c.adopt).toHaveBeenCalledOnce();
            c.host.attachDataFacade(c.channel);
        } finally {await pump.close(); vi.useRealTimers(); await work; await c.host.close();}
    });
    it.each([
        {cold: true, duration: 14_000, expected: "readable"},
        {cold: true, duration: 16_000, expected: "sync_stalled"},
        {cold: false, duration: 14_000, expected: "readable"},
        {cold: false, duration: 16_000, expected: "readable"},
    ])("streamed RPC keeps its own body deadline, not the earlier sync clock: $cold / $duration", async ({cold, duration, expected}) => {
        const c = await readableFixture(), observation = c.f.runtime.observations();
        let confirmed = 0, issued = false, outcome = "opening", rpcAborted = false;
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {...observation.status, confirmedThrough: confirmed, headKnown: 1}}));
        const runtime: AppLogRuntime = {
            takeLogCalls: () => {
                if (issued) return []; issued = true;
                return [{endpoint: 37, frame: encode(new Map<number, CborValue>([[0, 0], [1, 1], [2, "read"],
                    [3, new Map<number, CborValue>([[0, uuidToBytes(c.options.scope.collection)], [1, 0]])]]))}];
            },
            acceptLogReply: () => {confirmed = 1; return true;}, logNoResponse: vi.fn(), retireLog: vi.fn(),
        };
        const transport = new AppHttpLogTransport({endpoint: 37, collection: c.options.scope.collection,
            origin: "https://log.example.test", directOrigins: [], isCurrent: () => true,
            accessToken: async () => "fixture-token",
            signLogProof: async () => {await new Promise(resolve => setTimeout(resolve, 4_000)); return new Uint8Array(64);},
        }, {fetch: vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith("/v1/nonce")) return new Response("11".repeat(32));
            // Actual HTTP framing/body streaming; native acknowledgement is mocked.
            const raw = encode(new Map<number, CborValue>([[0, 1], [1, 1], [2, new Uint8Array(2 * 1024 * 1024)]]));
            const size = Math.ceil(raw.length / 4);
            return new Response(new ReadableStream<Uint8Array>({start(controller) {
                const timers = [0, 4_000, 8_000, duration].map((delay, i) => setTimeout(() => {
                    controller.enqueue(raw.slice(i * size, Math.min((i + 1) * size, raw.length)));
                    if (i === 3) {init!.signal!.removeEventListener("abort", abort); controller.close();}
                }, delay));
                const abort = () => {rpcAborted = true; timers.forEach(clearTimeout); controller.error(Error("RPC deadline"));};
                init!.signal!.addEventListener("abort", abort, {once: true});
            }}));
        })});
        const pump = new AppLogPump(runtime, transport, {endpoint: 37, collection: c.options.scope.collection});
        c.f.runtime.bindLogTransport.mockReturnValue(pump);
        await c.host.startCollectionLog({signal: c.options.signal});
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold}).then(
            () => {outcome = "readable";}, error => {outcome = error.reason;});
        try {
            await vi.advanceTimersByTimeAsync(15_500);
            expect(outcome).toBe("opening");
            expect(confirmed).toBe(0);
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            await vi.advanceTimersByTimeAsync(5_000); await work;
            expect(outcome).toBe(expected);
            if (duration > 15_000) expect(rpcAborted).toBe(true);
            expect(c.reader.query).toHaveBeenCalledTimes(expected === "readable" ? 1 : 0);
            if (expected !== "readable") expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            expect(transport.responseProgress()).toEqual([]);
        } finally {await pump.close(); await c.host.close(); vi.useRealTimers();}
    });
    it.each(["stops", "new_call"])('provisional bytes that $0 cannot keep an unadvanced cold replica alive', async kind => {
        const c = await readableFixture(); await c.host.startCollectionLog({signal: c.options.signal});
        c.pump.pump.mockImplementation(() => new Promise(() => {}));
        let active = [{id: 1, bytes: 1}];
        c.pump.responseProgress.mockImplementation(() => active);
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold: true}).then(() => null, error => error);
        try {
            await vi.advanceTimersByTimeAsync(5_000); active[0]!.bytes++;
            if (kind === "new_call") {
                await vi.advanceTimersByTimeAsync(10_000);
                active = [{id: 2, bytes: 100}]; // Prior call settled without native progress.
                await vi.advanceTimersByTimeAsync(250);
            } else await vi.advanceTimersByTimeAsync(15_250);
            expect(await work).toMatchObject({reason: "sync_stalled"});
            expect(c.reader.query).not.toHaveBeenCalled();
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            expect(vi.getTimerCount()).toBe(0);
        } finally {await c.host.close(); vi.useRealTimers();}
    });
    it("reports observed snapshot/replay/READ stages, never errors or collection contents", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        const observation = c.f.runtime.observations();
        let installing = true, confirmed = 0;
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {...observation.status, mode: "synced", confirmedThrough: confirmed, headKnown: 10, installing: installing ? {done: 1, total: 10} : undefined}}));
        c.pump.pump.mockImplementation(async () => {installing = false; confirmed = Math.min(10, confirmed + 5); return {quiet: true};});
        const stages: string[] = [];
        await c.host.waitForVerifiedRead({signal: c.options.signal, cold: true, onProgress: stage => stages.push(stage)});
        expect(stages[0]).toBe("loading_snapshot");
        expect(stages).toContain("replaying");
        expect(stages.at(-1)).toBe("verifying_read");
        expect(c.reader.query).toHaveBeenCalled();
        await c.host.close();
    });
    it("cold first sync with no accepted progress fails typed and bounded, never handing out a facade", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        c.pump.pump.mockImplementation(() => new Promise(() => {}));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold: true}).then(() => null, error => error);
        try {
            await vi.advanceTimersByTimeAsync(15_000);
            expect(await work).toMatchObject({reason: "sync_stalled"});
            expect(c.reader.query).not.toHaveBeenCalled();
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            expect(c.adopt).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it("cold stall clock starts from the last accepted progress, not the open's start", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        let confirmed = 0;
        const observation = c.f.runtime.observations();
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {...observation.status, confirmedThrough: confirmed, headKnown: 10}}));
        c.pump.pump.mockImplementation(() => new Promise(() => {}));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        let outcome = "opening";
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold: true}).then(
            () => {outcome = "readable";}, error => {outcome = error.reason;});
        try {
            await vi.advanceTimersByTimeAsync(5_000); confirmed = 1;
            await vi.advanceTimersByTimeAsync(14_999);
            expect(outcome).toBe("opening");
            await vi.advanceTimersByTimeAsync(251); await work;
            expect(outcome).toBe("sync_stalled");
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it("cold head growth without accepted prefix progress cannot hide a stalled replica", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        const observation = c.f.runtime.observations();
        let head = 0;
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {
            ...observation.status, mode: "synced", confirmedThrough: 0, headKnown: ++head,
        }}));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold: true}).then(() => null, error => error);
        try {
            await vi.advanceTimersByTimeAsync(15_000);
            expect(await work).toMatchObject({reason: "sync_stalled"});
            expect(c.reader.query).not.toHaveBeenCalled();
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it.each([{status: 401, code: "account_suspended"}, {status: 403, code: "forbidden"}, {status: 409, code: "collection_migrating"}])("cold sync propagates explicit $code without waiting for a stall or handing out a facade", async ({status, code}) => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        const server = appServerProblem(status, {error: {code}});
        c.pump.pump.mockImplementation(async () => {Object.assign(c.pump, {terminalProblem: server}); return {quiet: true};});
        await expect(c.host.waitForVerifiedRead({signal: c.options.signal, cold: true})).rejects.toMatchObject({server});
        expect(c.reader.query).not.toHaveBeenCalled();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        expect(c.mint).toHaveBeenCalledOnce();
        await c.host.close();
    });
    it.each([
        {status: 401, code: null}, {status: 401, code: "unauthenticated"}, {status: 403, code: "invalid_proof"},
        {status: 404, code: "not_found"}, {status: 408, code: "timeout"}, {status: 409, code: "route_not_ready"},
    ])("cold open recovers from HTTP $status / $code followed by native accepted success", async ({status, code}) => {
        const c = await readableFixture(), observation = c.f.runtime.observations();
        let confirmed = 0, issued = 0, posts = 0, tokenGeneration = 1;
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {...observation.status, confirmedThrough: confirmed, headKnown: 1}}));
        const runtime: AppLogRuntime = {
            takeLogCalls: () => confirmed ? [] : [{endpoint: 37, frame: encode(new Map<number, CborValue>([[0, 0], [1, ++issued], [2, "read"],
                [3, new Map<number, CborValue>([[0, uuidToBytes(c.options.scope.collection)], [1, 0]])]]))}],
            acceptLogReply: () => {confirmed = 1; return true;}, logNoResponse: vi.fn(), retireLog: vi.fn(),
        };
        const auth = {endpoint: 37, collection: c.options.scope.collection, origin: "https://log.example.test", directOrigins: [],
            isCurrent: () => true, accessToken: vi.fn(async () => `fixture-token-${tokenGeneration}`),
            invalidateToken: vi.fn(() => {tokenGeneration++;}), signLogProof: vi.fn(async () => new Uint8Array(64)),
        };
        const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
            if (String(url).endsWith("/v1/nonce")) return new Response("11".repeat(32));
            if (++posts === 1) return new Response(code === null ? "unauthenticated" : JSON.stringify({error: {code, details: {reason: "expired"}}}), {status});
            return new Response(encode(new Map<number, CborValue>([[0, 1], [1, issued], [2, null]])).slice());
        });
        const pump = new AppLogPump(runtime, new AppHttpLogTransport(auth, {fetch}), {endpoint: 37, collection: c.options.scope.collection});
        c.f.runtime.bindLogTransport.mockReturnValue(pump);
        await c.host.startCollectionLog({signal: c.options.signal});
        try {
            await c.host.waitForVerifiedRead({signal: c.options.signal, cold: true});
            expect(posts).toBe(2);
            expect(auth.accessToken).toHaveBeenCalledTimes(2); expect(auth.signLogProof).toHaveBeenCalledTimes(2);
            expect(auth.invalidateToken).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
            expect(runtime.logNoResponse).toHaveBeenCalledOnce();
            expect(c.reader.query).toHaveBeenCalledOnce();
            expect(c.mint).toHaveBeenCalledOnce(); expect(c.adopt).toHaveBeenCalledOnce();
            c.host.attachDataFacade(c.channel);
        } finally {await pump.close(); await c.host.close();}
    });
    it.each(["key_scan", "snapshot"])("cold %s advances are progress without claiming a readable prefix", async kind => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        const observation = c.f.runtime.observations();
        let done = 0, complete = false;
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {
            ...observation.status, mode: "synced", confirmedThrough: complete ? 10 : 0, headKnown: 10,
            incidents: !complete && kind === "key_scan" ? [{kind: "waiting_for_key", details: new Map<string, CborValue>([["position", 1], ["reason", "reading"]])}] : [],
            ...(!complete && kind === "snapshot" ? {installing: {done, total: 4}} : {}),
        }}));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        let outcome = "opening";
        const work = c.host.waitForVerifiedRead({signal: c.options.signal, cold: true}).then(
            () => {outcome = "readable";}, error => {outcome = error.reason;});
        try {
            for (let i = 0; i < 4; i++) {
                await vi.advanceTimersByTimeAsync(5_000); done++;
                if (kind === "key_scan") c.pump.readProgress++;
                expect(outcome).toBe("opening");
                expect(c.reader.query).not.toHaveBeenCalled();
                expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            }
            complete = true;
            await vi.advanceTimersByTimeAsync(1_001); await work;
            expect(outcome).toBe("readable");
            expect(c.reader.query).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it("cold cancellation removes its progress watchdog and cannot admit a late read", async () => {
        const c = await readableFixture(), caller = new AbortController();
        await c.host.startCollectionLog({signal: c.options.signal});
        c.pump.pump.mockImplementation(() => new Promise(() => {}));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const work = c.host.waitForVerifiedRead({signal: caller.signal, cold: true}).then(() => null, error => error);
        try {
            await vi.advanceTimersByTimeAsync(1_000); caller.abort();
            expect(await work).toMatchObject({reason: "fenced"});
            expect(vi.getTimerCount()).toBe(0);
            expect(c.reader.query).not.toHaveBeenCalled();
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it("paces a one-second first-key wait within the original read deadline without hot-turn exhaustion", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal, allowLoopbackHttp: true});
        let keyed = false, outcome = "waiting";
        const observation = c.f.runtime.observations();
        c.f.runtime.observations.mockImplementation(() => ({...observation, status: {
            ...observation.status, incidents: keyed ? [] : [{kind: "waiting_for_key", details: new Map()}],
        }}));
        c.reader.query.mockImplementation(async () => {
            if (!keyed) throw mdbaseError("unavailable", "verified prefix warming");
            return {records: []};
        });
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const keyArrives = setTimeout(() => {keyed = true;}, 1000);
        const work = c.host.waitForVerifiedRead({signal: c.options.signal}).then(
            () => {outcome = "readable";}, error => {outcome = error.reason ?? "failed";});
        try {
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            await vi.advanceTimersByTimeAsync(2000);
            expect(outcome).toBe("readable");
            expect(c.adopt).toHaveBeenCalledOnce();
            expect(c.mint).toHaveBeenCalledOnce();
            expect(c.sqlClose).not.toHaveBeenCalled();
        } finally {
            clearTimeout(keyArrives); vi.useRealTimers(); await work; await c.host.close();
        }
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
            status: { mode: "synced", connection: "online", incidents: [], pending: 0, confirmedThrough: 99, headKnown: 99, holds: 0, unresolved: 0 },
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
    it("paces an unreadable prefix to the original 15 s deadline, then stops without a facade", async () => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        c.reader.query.mockRejectedValue(mdbaseError("unavailable", "prefix pending"));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        try {
            const work = c.host.waitForVerifiedRead({signal: c.options.signal});
            const rejected = expect(work).rejects.toMatchObject({reason: "unavailable"});
            await vi.advanceTimersByTimeAsync(14_999);
            expect(c.reader.query.mock.calls.length).toBeGreaterThan(2);
            expect(c.reader.query.mock.calls.length).toBeLessThan(20);
            expect(() => c.host.attachDataFacade(c.channel)).toThrow();
            await vi.advanceTimersByTimeAsync(1); await rejected;
            const calls = c.reader.query.mock.calls.length;
            await vi.advanceTimersByTimeAsync(30_000);
            expect(c.reader.query).toHaveBeenCalledTimes(calls);
            expect(vi.getTimerCount()).toBe(0);
            expect(c.adopt).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it("cancels the paced READ wait without another pump/query or a replacement host", async () => {
        const c = await readableFixture(), caller = new AbortController();
        await c.host.startCollectionLog({signal: c.options.signal});
        c.reader.query.mockRejectedValue(mdbaseError("unavailable", "key pending"));
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        try {
            const work = c.host.waitForVerifiedRead({signal: caller.signal});
            const rejected = expect(work).rejects.toMatchObject({reason: "fenced"});
            await vi.advanceTimersByTimeAsync(100);
            expect(c.reader.query).toHaveBeenCalledOnce();
            caller.abort(); await rejected;
            await vi.advanceTimersByTimeAsync(20_000);
            expect(c.reader.query).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
            expect(c.sqlClose).not.toHaveBeenCalled();
        } finally {vi.useRealTimers(); await c.host.close();}
    });
    it.each([
        {cold: false, code: "unauthenticated"}, {cold: true, code: "unauthenticated"},
        {cold: false, code: "forbidden"}, {cold: true, code: "forbidden"},
    ] as const)("does not retry typed native $code READ failure, cold=$cold", async ({cold, code}) => {
        const c = await readableFixture();
        await c.host.startCollectionLog({signal: c.options.signal});
        const error = mdbaseError(code, "access removed");
        c.reader.query.mockRejectedValue(error);
        await expect(c.host.waitForVerifiedRead({signal: c.options.signal, cold})).rejects.toBe(error);
        expect(c.reader.query).toHaveBeenCalledOnce();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        await c.host.close();
    });
    it("READ deadline covers an ignored-cancellation Query and never admits its late success", async () => {
        const c = await readableFixture();
        let finish!: () => void;
        c.reader.query.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({records: []});}));
        await expect(c.host.waitForVerifiedRead({signal: c.options.signal, timeoutMs: 10})).rejects.toMatchObject({reason: "unavailable"});
        finish(); await Promise.resolve();
        expect(() => c.host.attachDataFacade(c.channel)).toThrow();
        expect(c.reader.close).toHaveBeenCalledOnce();
        await c.host.close();
    });
    it("READ deadline closes a late connect that ignored cancellation", async () => {
        const c = await readableFixture();
        let finish!: () => void;
        c.connect.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve(c.reader as unknown as MdbaseClient);}));
        await expect(c.host.waitForVerifiedRead({signal: c.options.signal, timeoutMs: 10})).rejects.toMatchObject({reason: "unavailable"});
        finish(); await Promise.resolve(); await Promise.resolve();
        expect(c.reader.close).toHaveBeenCalledOnce();
        expect(c.reader.query).not.toHaveBeenCalled();
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
    it("new caller signals retain the original private bootstrap signal during SQL adoption", async () => {
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
        c.host.adoptCloudCopy(options, sql);
        expect(c.adopt).toHaveBeenCalledOnce();
        expect(c.adopt.mock.calls[0]![0].signal).toBe(c.bootstrap.mock.calls[0]![0].signal);
        expect(c.adopt.mock.calls[0]![0].signal).not.toBe(options.signal);
        await c.host.close();
    });
    it("outcome versionchange still refuses SQL adoption with any caller signal", async () => {
        const c = await collectionFixture(); await c.host.bootstrapCloudCopy(c.options); c.store.close();
        expect(() => c.host.adoptCloudCopy({signal: new AbortController().signal,
            replicaId: c.f.receipt.deviceId, endpoint: 37, opened: "fresh", sqliteVersion: 3053004, cloudCopyOptIn: true},
            {import: vi.fn(), fence: vi.fn(), needsRecovery: false})).toThrow();
        expect(c.adopt).not.toHaveBeenCalled(); await c.host.close();
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
