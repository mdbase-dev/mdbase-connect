/** Production web host composition (internal until full bootstrap/read qualification).
 * Device phase uses the actual persistent browser provider/stores and actual CP
 * registration. No fixture/memory custody or default roots. Collection SQL opens
 * only after ownership + protected completion; native reads gate the data facade. */
import { idbLogTokenCache } from "./log-token-cache.js";
import { currentAppOrigin } from "./app-origin.js";
import { uuidToBytes } from "../codec.js";
import { collectionDisplayName } from "./collection-display-name.js";
import { MdbaseClient } from "../client.js";
import { MdbaseError } from "../errors.js";
import { inProcessConnector } from "../transport/inprocess.js";
import { AppCpLogAuthority } from "./cp-authority.js";
import { AppLogPushChannel, type AppLogPushEvents } from "./log-push.js";
import { AppCpPeopleAuthority } from "./cp-people.js";
import { attachAppTimerReceiver } from "./timer-port.js";
import type { PeopleAuthority } from "../people.js";
import type { AppLogHealth, AppLogPump } from "./log-pump.js";
import type { AppServerProblem } from "./cp-problem.js";
import { initialSyncWait, keyWaitDetail, type AppInitialSyncWait } from "./initial-sync.js";
import { attachAppLocalFacade } from "./local-facade.js";
import {
    AppCpCloudCopyBootstrap,
    type AppBundledReleaseTrust,
    type AppCloudCopyBootstrapMetadata,
    type AppCloudCopyAdoptionOptions,
    type AppCpCloudCopySession,
} from "./cloud-copy-bootstrap.js";
import {
    AppWebCloudCopyBootstrapPersistence,
    type AppCloudCopyOutcomeScope,
} from "./cloud-copy-persistence.js";
import { AppIndexedDbCloudCopyOutcomeStore } from "./cloud-copy-persistence-idb.js";
import type { AppReplicaScope } from "./owner.js";
import type { AppSqlLifetime } from "./wasm-runtime.js";
import { AppIndexedDbDeviceKeyProvider } from "./device-key-provider.js";
import { AppIndexedDbDeviceKeyProtectedStore } from "./device-key-idb.js";
import { AppWebDeviceKeyCustody } from "./device-key-custody.js";
import { AppIndexedDbNoiseProtectedStore } from "./noise-idb.js";
import { AppWebNoiseCustody } from "./noise-custody.js";
import type { AppProtectedInstallationSignIn, AppInstallationSignInView, AppInstallationTimerConsent } from "./installation-sign-in.js";
import {
    AppCpDeviceRegistration,
    type AppCpDeviceSession,
} from "./device-registration.js";
import type { AppInstallationCustodyAuthority } from "./owner.js";
import {
    AppWasmRuntime,
    AppStrictDeviceApprovalError,
    type AppDeviceRegistrationReceipt,
    type AppNoiseCustodyResult,
} from "./wasm-runtime.js";

/** Authenticated first-party selection, NOT caller/UI-selected grant authority.
 * The installation ledger must establish explicit fresh/existing before this
 * entry; missing/corrupt existing and interrupted initialization require recovery. */
export interface AppCloudCopyHostSession extends AppCpDeviceSession {
    readonly accountId: string;
    readonly logOrigin: string;
    readonly approvalMode: "password-ak1" | "strict";
    /** Original protected CP receipt metadata; absent means no timer reference.
     * Neither this snapshot nor its public IDs authorize a CP operation. */
    timerConsent?(): AppInstallationTimerConsent | null;
}
/** SAME public bundled output of the shared BUILD verifier; never discover at
 * runtime. Release context/tool authentication precedes host construction. */
export type AppCloudCopyHostRelease = AppBundledReleaseTrust;
export class AppCloudCopyHostError extends Error {
    constructor(
        readonly reason:
            "binding" | "fenced" | "recovery_required" | "unavailable",
    ) {
        super(`app cloud copy host: ${reason}`);
        this.name = "AppCloudCopyHostError";
    }
}
/** Attached tabs per replica: the leader plus followers. */
const MAX_FACADES = 32;
/** Bounded back-to-back turns in one foreground drive. */
const DRIVE_TURNS = 8;
const fail = (r: AppCloudCopyHostError["reason"]) =>
    new AppCloudCopyHostError(r);
const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
/** Owns nonexported KEK and ciphertext handles for SAME original installation.
 * Call close/terminate through openOwnedAppWorker; this object never unlocks.
 * No raw key/KEK getter or generic store/sign/DH surface. */
export class AppWebCloudCopyHost {
    private closing = false;
    private closeResult: Promise<void> | null = null;
    private provider: AppIndexedDbDeviceKeyProvider | null = null;
    private keys: AppIndexedDbDeviceKeyProtectedStore | null = null;
    private noiseStore: AppIndexedDbNoiseProtectedStore | null = null;
    private key: CryptoKey | null = null;
    private noise: AppWebNoiseCustody | null = null;
    private native: AppWasmRuntime | null = null;
    private publicReceipt: AppDeviceRegistrationReceipt | null = null;
    private signIn: AppProtectedInstallationSignIn | null = null;
    private originalCustody: AppNoiseCustodyResult | null = null;
    private collectionAttempted = false;
    // Original collection cancellation remains bound to protected bootstrap
    // storage/adoption. Each public call also observes its own caller signal.
    private collectionSignal: AbortSignal | null = null;
    private collectionCurrent: (() => boolean) | null = null;
    private outcomeStore: AppIndexedDbCloudCopyOutcomeStore | null = null;
    private outcome: AppWebCloudCopyBootstrapPersistence | null = null;
    private bootstrap: AppCpCloudCopyBootstrap | null = null;
    private bootstrapConfirmed = false;
    private collectionScope: Readonly<AppReplicaScope> | null = null;
    private collectionSession: AppCpCloudCopySession | null = null;
    private adoptedEndpoint: number | bigint | null = null;
    private sqlAttempted = false;
    private sqlClose: (() => Promise<void>) | null = null;
    private collectionSql: AppSqlLifetime | null = null;
    private logRequest: typeof fetch | null = null;
    private logLoopback = false;
    private logWork: Promise<void> | null = null;
    private authority: AppCpLogAuthority | null = null;
    private peopleMetadata: { authority: AppCpPeopleAuthority; view: PeopleAuthority } | null = null;
    private pump: AppLogPump | null = null;
    private readonly timerPorts = new Set<{close():Promise<void>}>();
    private readWork: Promise<void> | null = null;
    private readAbort: AbortController | null = null;
    private readClient: MdbaseClient | null = null;
    private readVerified = false;
    /** One data facade per attached tab (the first, then any follower tabs). */
    private readonly facades = new Map<MessagePort, ReturnType<typeof attachAppLocalFacade>>();
    private logWorkListener: (() => void) | null = null;
    private readonly selected: Readonly<{
        accountId: string;
        connectorId: string;
        deviceId: string;
        installationId: string;
        kind: "mobile" | "app-runtime";
        cpOrigin: string;
        logOrigin: string;
        approvalMode: "password-ak1" | "strict";
    }>;
    private readonly currentCallback: AppCloudCopyHostSession["isCurrent"];
    private readonly bearerCallback: AppCloudCopyHostSession["connectorBearer"];
    private readonly ownershipCallback: AppInstallationCustodyAuthority["isCurrent"];
    private readonly trust: AppCloudCopyHostRelease;
    private readonly pin: AppCloudCopyHostSession & {
        installationOwned(): boolean;
    };
    private constructor(
        private readonly source: AppCloudCopyHostSession,
        private readonly installation: AppInstallationCustodyAuthority,
        private readonly originalRelease: AppCloudCopyHostRelease,
        private readonly origin: string,
        private readonly lifetime: AbortSignal,
    ) {
        this.selected = Object.freeze({
            accountId: source.accountId,
            connectorId: source.connectorId,
            deviceId: source.deviceId,
            installationId: source.installationId,
            kind: source.kind,
            cpOrigin: source.cpOrigin,
            logOrigin: source.logOrigin,
            approvalMode: source.approvalMode,
        });
        this.currentCallback = source.isCurrent;
        this.bearerCallback = source.connectorBearer;
        this.ownershipCallback = installation.isCurrent;
        for (const v of [
            source.accountId,
            source.connectorId,
            source.deviceId,
            source.installationId,
        ])
            if (uuidToBytes(v).every((b) => b === 0)) throw fail("binding");
        if (
            (source.kind !== "app-runtime" && source.kind !== "mobile") ||
            originalRelease.schema !== "mdbn-app-trust/release/1" ||
            originalRelease.cpOrigin !== source.cpOrigin ||
            originalRelease.logOrigin !== source.logOrigin ||
            !/^[0-9a-f]{64}$/.test(originalRelease.assetSha256) ||
            !originalRelease.trustedRoots.length ||
            originalRelease.trustedRoots.length > 64 ||
            !originalRelease.policyPins.length ||
            originalRelease.policyPins.length > 65536
        )
            throw fail("binding");
        this.trust = Object.freeze({
            ...originalRelease,
            source: Object.freeze({ ...originalRelease.source }),
            trustedRoots: Object.freeze(
                originalRelease.trustedRoots.map((v) => {
                    if (
                        !(v instanceof Uint8Array) ||
                        v.length !== 32 ||
                        v.every((b) => b === 0)
                    )
                        throw fail("binding");
                    return new Uint8Array(v);
                }),
            ),
            policyPins: new Uint8Array(originalRelease.policyPins),
        });
        this.pin = Object.freeze({
            ...this.selected,
            isCurrent: () => this.current(),
            installationOwned: () => this.current(),
            connectorBearer: async ({ signal }: { signal: AbortSignal }) => {
                this.check(signal);
                const value = await this.bearerCallback.call(
                    this.source,
                    Object.freeze({ signal }),
                );
                this.check(signal);
                return value;
            },
        });
        if (source.approvalMode === "strict")
            throw new AppStrictDeviceApprovalError();
        this.check(lifetime);
    }
    private current(): boolean {
        try {
            const r = this.originalRelease,
                t = this.trust;
            return (
                !this.closing &&
                !this.lifetime.aborted &&
                currentAppOrigin() === this.origin &&
                this.source.isCurrent === this.currentCallback &&
                this.source.connectorBearer === this.bearerCallback &&
                this.installation.isCurrent === this.ownershipCallback &&
                this.currentCallback.call(this.source) === true &&
                this.ownershipCallback.call(this.installation) === true &&
                this.installation.scope.account === this.selected.accountId &&
                this.installation.scope.installation ===
                    this.selected.installationId &&
                Object.entries(this.selected).every(
                    ([k, v]) =>
                        this.source[k as keyof AppCloudCopyHostSession] === v,
                ) &&
                r.schema === t.schema &&
                r.environment === t.environment &&
                r.cpOrigin === t.cpOrigin &&
                r.logOrigin === t.logOrigin &&
                r.assetSha256 === t.assetSha256 &&
                r.source.repository === t.source.repository &&
                r.source.commit === t.source.commit &&
                r.source.version === t.source.version &&
                r.trustedRoots.length === t.trustedRoots.length &&
                r.trustedRoots.every((v, i) => equal(v, t.trustedRoots[i]!)) &&
                equal(r.policyPins, t.policyPins)
            );
        } catch {
            return false;
        }
    }
    private check(signal: AbortSignal): void {
        if (signal.aborted || !this.current()) throw fail("fenced");
    }
    private operationSignal(caller: AbortSignal): AbortSignal {
        const signal = AbortSignal.any([
            this.lifetime,
            ...(this.collectionSignal ? [this.collectionSignal] : []),
            caller,
        ]);
        this.check(signal);
        return signal;
    }
    /** Must run INSIDE owned Worker initialization, after installation acquisition.
     * loadRuntime is the explicit authenticated immutable-artifact intake, not a
     * MemStore/legacy/default module selector. No collection query/SQL/facade yet. */
    static async openOriginalDevice(options: {
        session: AppCloudCopyHostSession;
        installation: AppInstallationCustodyAuthority;
        release: AppCloudCopyHostRelease;
        origin: string;
        mode: "fresh" | "existing";
        signal: AbortSignal;
        loadRuntime(options: { signal: AbortSignal }): Promise<Uint8Array>;
        fetch?: typeof fetch;
        allowLoopbackHttp?: boolean;
    }): Promise<AppWebCloudCopyHost> {
        const {
            session,
            installation,
            release,
            origin,
            mode,
            signal,
            loadRuntime,
            fetch: request,
            allowLoopbackHttp,
        } = options;
        let host: AppWebCloudCopyHost | null = null;
        try {
            if (!["fresh", "existing"].includes(mode)) throw fail("binding");
            host = new AppWebCloudCopyHost(
                session,
                installation,
                release,
                origin,
                signal,
            );
            const {custody, restored} = await host.openOwnedDevice({mode, signal, loadRuntime, allowLoopbackHttp, requireReceipt: true});
            if (mode === "existing") {
                host.native!.acknowledgeDeviceRegistration(restored!.receipt!);
                host.check(signal);
                host.publicReceipt = host.native!.registeredDeviceReceipt();
            } else {
                const receipt = await new AppCpDeviceRegistration(
                    host.native!,
                    host.pin,
                    custody,
                    host.noise!,
                    { fetch: request, allowLoopbackHttp },
                ).register(Object.freeze({ signal }));
                host.check(signal);
                host.publicReceipt = receipt;
            }
            return host;
        } catch (e) {
            await host?.close();
            if (
                e instanceof AppCloudCopyHostError ||
                e instanceof AppStrictDeviceApprovalError
            )
                throw e;
            throw fail("unavailable");
        }
    }
    /** SAME protected installation flow -> SAME original native lifetime. No
     * /devices registration, second open, seed re-loan or raw custody getter.
     * User account confirmation and actual installation ownership precede the
     * committed attempt; partial EXISTING state never authorizes fresh keys. */
    static async openInstallationDevice(options: {
        signIn: AppProtectedInstallationSignIn;
        installation: AppInstallationCustodyAuthority;
        release: AppCloudCopyHostRelease;
        origin: string;
        signal: AbortSignal;
        loadRuntime(options: {signal: AbortSignal}): Promise<Uint8Array>;
        allowLoopbackHttp?: boolean;
    }): Promise<AppWebCloudCopyHost> {
        const {signIn, installation, release, origin, signal, loadRuntime, allowLoopbackHttp} = options;
        let host: AppWebCloudCopyHost | null = null;
        try {
            const session = signIn.confirmedHostSession(release.logOrigin, release.environment);
            host = new AppWebCloudCopyHost(session, installation, release, origin, signal);
            host.signIn = signIn;
            const prepared = await signIn.prepareOriginalDevice(installation);
            host.check(signal);
            const {custody, restored} = await host.openOwnedDevice({mode: prepared.mode, signal, loadRuntime, allowLoopbackHttp, requireReceipt: false});
            host.originalCustody = custody;
            if (restored?.receipt && signIn.view().state !== "paired") throw fail("recovery_required");
            // Protect original Noise immediately, even before explicit attestation.
            await host.noise!.pending(new Uint8Array(custody.envelope), {signal});
            host.check(signal);
            // Completed restore is entirely local: no pairing/register HTTP.
            if (signIn.view().state === "paired") await host.completeInstallationSignIn();
            return host;
        } catch (error) {
            await host?.close();
            throw error;
        }
    }
    /** ONE fixed enrol transcript with durable original proof. Lost replies
     * retain this native owner; only explicit SAME-flow reconciliation retries. */
    async attestInstallation(): Promise<AppInstallationSignInView> {
        this.check(this.lifetime);
        if (!this.signIn || !this.native || !this.originalCustody || !this.noise) throw fail("binding");
        const view = await this.signIn.attest({runtime: this.native, custody: this.originalCustody, persistence: this.noise, installation: this.installation});
        this.check(this.lifetime);
        return view;
    }
    /** Call only after explicit flow.exchange has protected the credential.
     * Durable SAME Noise receipt precedes SAME native ACK and host readiness. */
    async completeInstallationSignIn(): Promise<AppDeviceRegistrationReceipt> {
        this.check(this.lifetime);
        if (!this.signIn || !this.native || !this.originalCustody || !this.noise) throw fail("binding");
        await this.signIn.acknowledge({runtime: this.native, custody: this.originalCustody, persistence: this.noise, installation: this.installation});
        this.check(this.lifetime);
        this.publicReceipt = this.native.registeredDeviceReceipt();
        return this.registeredReceipt();
    }
    /** Shared original-device intake for old controller qualification and actual
     * installation sign-in. No mode inference or second custody implementation. */
    private async openOwnedDevice(options: {
        mode: "fresh" | "existing";
        signal: AbortSignal;
        loadRuntime(options: {signal: AbortSignal}): Promise<Uint8Array>;
        allowLoopbackHttp?: boolean;
        requireReceipt: boolean;
    }) {
        const {mode, signal, loadRuntime, allowLoopbackHttp, requireReceipt} = options;
        this.check(signal);
        this.provider = await AppIndexedDbDeviceKeyProvider.open({source: this.pin, origin: this.origin, mode, signal, allowLoopbackHttp});
        this.check(signal);
        this.key = this.provider.deviceCustodyKek({signal});
        this.check(signal);
        this.keys = await AppIndexedDbDeviceKeyProtectedStore.open({source: this.pin, origin: this.origin, mode, signal, allowLoopbackHttp});
        this.check(signal);
        this.noiseStore = await AppIndexedDbNoiseProtectedStore.open({source: this.pin, origin: this.origin, mode, signal, allowLoopbackHttp});
        this.check(signal);
        this.noise = new AppWebNoiseCustody(this.pin, this.key, this.noiseStore);
        const restored = await this.noise.restore({signal});
        this.check(signal);
        if (mode === "existing" ? !restored || (requireReceipt && !restored.receipt) : restored !== null) throw fail("recovery_required");
        const artifact = await loadRuntime(Object.freeze({signal}));
        this.check(signal);
        if (!(artifact instanceof Uint8Array) || !artifact.length) throw fail("binding");
        this.native = await AppWasmRuntime.createDevice(new Uint8Array(artifact));
        this.check(signal);
        const custody = await new AppWebDeviceKeyCustody(this.pin, this.key, this.keys).openNativeDevice(this.native, {
            signal, mode, noise: mode === "fresh" ? {mode: "fresh"} : {mode: "existing", envelope: restored!.envelope},
        });
        this.check(signal);
        return {custody, restored};
    }
    /** Called INSIDE the same owned collection Worker initialization. scope is
     * the original scope supplied by openOwnedAppWorker, collectionCurrent is
     * its trusted first-party lifetime fence (not a grant or SQL/readiness proof).
     * SAME nonexported KEK and bundled environment; no caller outcome adapter.
     * No SQL is opened here and completion is NOT readable/Saved authority. */
    async bootstrapCloudCopy(options: {
        scope: Readonly<AppReplicaScope>;
        collectionCurrent(): boolean;
        purpose: "create" | "join";
        outcomeMode: "fresh" | "existing";
        signal: AbortSignal;
        reconcile?: "explicit-unknown-outcome";
        /** Explicit cleartext initial label, captured before asynchronous work. */
        displayName?: string;
        fetch?: typeof fetch;
        allowLoopbackHttp?: boolean;
    }): Promise<AppCloudCopyBootstrapMetadata> {
        const {
            scope,
            collectionCurrent,
            purpose,
            outcomeMode,
            signal: callerSignal,
            reconcile,
            fetch: request,
            allowLoopbackHttp,
        } = options;
        const signal = this.operationSignal(callerSignal);
        const requestedName = options.displayName;
        const displayName = requestedName === undefined ? undefined : collectionDisplayName(requestedName);
        if (displayName !== undefined && purpose !== "create") throw fail("binding");
        this.check(signal);
        if (
            this.collectionAttempted ||
            !this.native ||
            !this.key ||
            !this.publicReceipt ||
            scope.account !== this.selected.accountId ||
            scope.installation !== this.selected.installationId ||
            !["create", "join"].includes(purpose) ||
            !["fresh", "existing"].includes(outcomeMode) ||
            uuidToBytes(scope.collection).every((v) => v === 0)
        )
            throw fail("binding");
        const original = Object.freeze({
            account: scope.account,
            installation: scope.installation,
            collection: scope.collection,
        });
        const current = () => {
            try {
                return (
                    this.current() &&
                    !signal.aborted &&
                    options.scope === scope &&
                    options.collectionCurrent === collectionCurrent &&
                    Object.entries(original).every(
                        ([k, v]) => scope[k as keyof AppReplicaScope] === v,
                    ) &&
                    collectionCurrent.call(options) === true &&
                    this.outcomeStore?.fenced !== true
                );
            } catch {
                return false;
            }
        };
        if (!current()) throw fail("fenced");
        this.collectionAttempted = true;
        this.collectionSignal = signal;
        this.collectionCurrent = current;
        this.collectionScope = original;
        const source: AppCpCloudCopySession & AppCloudCopyOutcomeScope =
            Object.freeze({
                ...this.pin,
                collection: original.collection,
                purpose,
                assetSha256: this.trust.assetSha256,
                ...(displayName === undefined ? {} : {displayName}),
                isCurrent: current,
            });
        this.collectionSession = source;
        try {
            this.outcomeStore = await AppIndexedDbCloudCopyOutcomeStore.open({
                source,
                origin: this.origin,
                mode: outcomeMode,
                signal,
                allowLoopbackHttp,
            });
            this.checkCollection(signal);
            this.outcome = new AppWebCloudCopyBootstrapPersistence(
                source,
                this.publicReceipt,
                this.key,
                this.outcomeStore,
                { mode: outcomeMode, signal },
            );
            this.native.prepareCloudCopyCollection(source);
            this.checkCollection(signal);
            this.bootstrap = new AppCpCloudCopyBootstrap(
                this.native,
                source,
                this.trust,
                this.outcome,
                { fetch: request, allowLoopbackHttp, ...(displayName === undefined ? {} : {displayName}) },
            );
            const metadata = await this.bootstrap.bootstrap(
                Object.freeze({ signal, ...(reconcile ? { reconcile } : {}) }),
            );
            this.checkCollection(signal);
            this.bootstrapConfirmed = true;
            return metadata;
        } catch (error) {
            await this.close();
            throw error;
        }
    }
    private checkCollection(signal: AbortSignal): void {
        this.check(signal);
        if (this.collectionCurrent?.() !== true) throw fail("fenced");
    }
    /** SQL is supplied only AFTER collection ownership and an internally
     * confirmed protected completion. Native SAME-bundle adoption, not a fresh
     * seed loan or caller root/genesis override. Verified read still required. */
    adoptCloudCopy(
        options: AppCloudCopyAdoptionOptions,
        sql: AppSqlLifetime,
    ): void {
        const signal = this.operationSignal(options.signal);
        this.checkCollection(signal);
        if (
            !this.bootstrap ||
            !this.bootstrapConfirmed ||
            this.adoptedEndpoint !== null
        )
            throw fail("fenced");
        const endpoint = options.endpoint;
        // Preserve the exact original protected bootstrap signal internally;
        // never require the app to retrieve or loan the host's private lifetime.
        this.bootstrap.adoptCollection(
            { ...options, signal: this.collectionSignal! },
            sql,
        );
        this.checkCollection(signal);
        this.adoptedEndpoint = endpoint;
    }
    /** Trusted immutable storage intake callback: actual OPFS adapter in this
     * Worker, exact owned scope, no MemStore/reset/missing-existing fallback.
     * Callback cannot run until protected completion; root/genesis stay internal. */
    async openCollectionSql(options: {
        signal: AbortSignal;
        replicaId: string;
        endpoint: number | bigint;
        openSql(input: {
            scope: Readonly<AppReplicaScope>;
            signal: AbortSignal;
        }): Promise<{
            sql: AppSqlLifetime;
            opened: AppCloudCopyAdoptionOptions["opened"];
            sqliteVersion: number;
            /** Close SQL/VFS ONLY after native shutdown or Worker termination. */
            close(): Promise<void>;
        }>;
    }): Promise<void> {
        const { replicaId, endpoint, openSql } = options;
        const signal = this.operationSignal(options.signal);
        this.checkCollection(signal);
        if (
            !this.bootstrapConfirmed ||
            !this.collectionScope ||
            this.sqlAttempted ||
            this.adoptedEndpoint !== null
        )
            throw fail("binding");
        if (
            uuidToBytes(replicaId).every((v) => v === 0) ||
            (typeof endpoint !== "bigint" && !Number.isSafeInteger(endpoint)) ||
            BigInt(endpoint) < 0n ||
            BigInt(endpoint) > (1n << 64n) - 1n
        )
            throw fail("binding");
        this.sqlAttempted = true;
        try {
            const opened = await openSql.call(
                options,
                Object.freeze({ scope: this.collectionScope, signal }),
            );
            // Retain cleanup even if authority changed while the handle was opening.
            const close = opened.close;
            this.sqlClose = async () => {
                await close.call(opened);
            };
            this.collectionSql = opened.sql;
            this.checkCollection(signal);
            if (options.openSql !== openSql) throw fail("fenced");
            this.adoptCloudCopy(
                {
                    signal,
                    replicaId,
                    endpoint,
                    opened: opened.opened,
                    sqliteVersion: opened.sqliteVersion,
                    cloudCopyOptIn: true,
                },
                opened.sql,
            );
        } catch (error) {
            await this.close();
            throw error;
        }
    }
    /** Actual original-device CP credential -> native signed token -> fixed log
     * transport. Missing/offline credentials never become trusted defaults. */
    async startCollectionLog(options: {
        signal: AbortSignal;
        fetch?: typeof fetch;
        allowLoopbackHttp?: boolean;
    }): Promise<void> {
        const { fetch: request, allowLoopbackHttp } = options;
        const signal = this.operationSignal(options.signal);
        this.checkCollection(signal);
        if (
            !this.native ||
            !this.collectionSession ||
            this.adoptedEndpoint === null
        )
            throw fail("binding");
        const captured = request ?? globalThis.fetch,
            loopback = allowLoopbackHttp === true;
        if (
            this.authority &&
            (captured !== this.logRequest || loopback !== this.logLoopback)
        )
            throw fail("fenced");
        if (this.pump) return;
        if (this.logWork) {
            await this.logWork;
            this.checkCollection(signal);
            return;
        }
        if (!this.authority) {
            this.logRequest = captured;
            this.logLoopback = loopback;
            this.authority = new AppCpLogAuthority(
                this.native,
                Object.freeze({
                    ...this.collectionSession,
                    endpoint: this.adoptedEndpoint,
                    directOrigins: Object.freeze([]),
                }),
                { fetch: captured, allowLoopbackHttp, tokenCache: idbLogTokenCache() },
            );
        }
        // An offline token mint is NOT identity loss: retain the SAME authority,
        // SQL and original keys. A later explicit foreground call may retry it.
        const authority = this.authority;
        const work = (async () => {
            await authority.accessToken(Object.freeze({ signal }));
            this.checkCollection(signal);
            this.pump = this.native!.bindLogTransport(authority.logTransport());
        })();
        this.logWork = work;
        try {
            await work;
        } finally {
            if (this.logWork === work) this.logWork = null;
        }
    }
    /** Read-only metadata for this adopted collection. Uses the already pinned
     * CP transport; no session, credential, key or readiness authority escapes.
     * Compose with MdbasePeopleClient INSIDE the trusted owned Worker and send
     * only public projections across its caller channel. */
    peopleAuthority(): PeopleAuthority {
        this.checkCollection(this.lifetime);
        if (!this.collectionSession || this.adoptedEndpoint === null || !this.logRequest)
            throw fail("binding");
        if (!this.peopleMetadata) {
            const endpoint = this.adoptedEndpoint, session = this.collectionSession;
            const authority = new AppCpPeopleAuthority(Object.freeze({
                ...session,
                endpoint,
                directOrigins: Object.freeze([]),
                isCurrent: () => this.collectionCurrent?.() === true && this.adoptedEndpoint === endpoint,
                connectorBearer: async ({ signal }: { signal: AbortSignal }) => {
                    signal.throwIfAborted();
                    this.checkCollection(this.lifetime);
                    // Custody admits ONLY the original owner lifetime; the
                    // metadata request's child signal controls its HTTP work.
                    const bearer = await session.connectorBearer({ signal: this.lifetime });
                    this.checkCollection(this.lifetime);
                    signal.throwIfAborted();
                    return bearer;
                },
            }), { fetch: this.logRequest, allowLoopbackHttp: this.logLoopback });
            const view = Object.freeze<PeopleAuthority>({
                collection: authority.collection,
                isCurrent: () => authority.isCurrent(),
                request: (resource, options) => authority.request(resource, options),
            });
            this.peopleMetadata = { authority, view };
        }
        return this.peopleMetadata.view;
    }
    /** SAME Worker host/scope/child lifetime. Only the original chosen receipt
     * selects a fixed native CP receiver; no session or bearer leaves Worker. */
    openTimersPort(options:{scope:Readonly<AppReplicaScope>;generation:string;signal:AbortSignal}):{port:MessagePort;close():Promise<void>} | null {
        this.checkCollection(this.lifetime);
        if(!this.readVerified || !this.logRequest || !this.collectionScope || options.signal.aborted) throw fail("binding");
        const {scope,generation,signal}=options,original=this.collectionScope;
        if(scope.account!==original.account || scope.installation!==original.installation || scope.collection!==original.collection || uuidToBytes(generation).every(value=>value===0)) throw fail("binding");
        const callback=this.source.timerConsent,consent=callback?.call(this.source);
        if(!consent?.approved)return null;
        const grant=consent.grants.find(reference=>reference.collectionId===scope.collection);
        if(!grant)return null;
        const WorkerScope=(globalThis as typeof globalThis & {WorkerGlobalScope?:new()=>object}).WorkerGlobalScope;
        if(typeof WorkerScope!=="function" || !(globalThis instanceof WorkerScope)) throw fail("binding");
        if(uuidToBytes(grant.grantId).every(value=>value===0)||!/^[0-9a-f]{64}$/.test(grant.declarationDigest))throw fail("binding");
        const snapshot=JSON.stringify(consent),channel=new MessageChannel();
        const isCurrent=()=>{
            try{return !signal.aborted && options.signal===signal && options.scope===scope && options.generation===generation && this.collectionCurrent?.()===true && this.current()
                && scope.account===original.account && scope.installation===original.installation && scope.collection===original.collection
                && this.source.timerConsent===callback && JSON.stringify(callback?.call(this.source))===snapshot;}
            catch{return false;}
        };
        const receiver=attachAppTimerReceiver(channel.port1,{scope:original,generation,grantId:grant.grantId,cpOrigin:new URL(this.selected.cpOrigin).origin,
            signal,isCurrent,fetch:this.logRequest,...(this.signIn ? {journal:{
                read:()=>this.signIn!.originalTimerChannel(grant.grantId),
                write:(value:Parameters<AppProtectedInstallationSignIn["retainTimerChannel"]>[1])=>this.signIn!.retainTimerChannel(grant.grantId,value),
            }} : {}),bearer:async()=>{
                if(!isCurrent())throw fail("fenced");
                // Custody callback accepts ONLY original host lifetime. Child
                // cancellation fences HTTP, never borrows/unlocks the actor.
                const value=await this.bearerCallback.call(this.source,{signal:this.lifetime});
                if(!isCurrent())throw fail("fenced");return value;
            }});
        this.timerPorts.add(receiver);
        return Object.freeze({port:channel.port2,close:async()=>{await receiver.close();channel.port2.close();this.timerPorts.delete(receiver);}});
    }
    /** The live log's latest specific server refusal, or null. Display only. */
    serverProblem(): AppServerProblem | null {
        return this.pump?.serverProblem ?? null;
    }
    /** Typed health of the path to the log from the latest failed call, or
     * null once a reply was accepted. Display and retry pacing only. */
    transportHealth(): AppLogHealth | null {
        return this.pump?.transportHealth ?? null;
    }
    /** What the replica still waits for before it holds everything up to the
     * known log head, or null once it does (native sync status). */
    initialSync(): AppInitialSyncWait | null {
        try {
            if (!this.native) return "unavailable";
            return initialSyncWait(this.native.observations().status);
        } catch {
            return "unavailable";
        }
    }
    /** Diagnostics while waiting for a key (native sync status), else null. */
    keyWaitDetail(): Record<string, string | number> | null {
        try {
            return this.native ? keyWaitDetail(this.native.observations().status) : null;
        } catch {
            return null;
        }
    }
    /** Local writes not yet confirmed by the log (native sync status). */
    pendingWrites(): number {
        try {
            return this.native?.observations().status.pending ?? 0;
        } catch {
            return 0;
        }
    }
    /** Feed one push frame to the native replica (current log session only). */
    pushLog(frame: Uint8Array): boolean {
        try {
            return this.native?.pushLog(frame) === true;
        } catch {
            return false;
        }
    }
    /** The log's push socket for this collection, or null when the runtime cannot
     * sign its `hello` (older native asset): then the caller wakes on events only.
     * Requires the started log. The socket never carries requests. */
    openLogPush(events: AppLogPushEvents): AppLogPushChannel | null {
        this.checkCollection(this.lifetime);
        const native = this.native, authority = this.authority, session = this.collectionSession, request = this.logRequest;
        if (!native || !this.pump || !authority || !session || !request) throw fail("binding");
        if (!native.supportsLogPush || typeof WebSocket !== "function") return null;
        const loopback = this.logLoopback, origin = authority.origin;
        const current = () => {
            try { return this.collectionCurrent?.() === true && this.current() && this.authority === authority && authority.isCurrent(); } catch { return false; }
        };
        return new AppLogPushChannel({
            origin, collection: authority.collection, deviceId: session.deviceId, isCurrent: current,
            accessToken: options => authority.accessToken(options),
            invalidateToken: token => authority.invalidateToken(token),
            nonce: async ({ signal }) => {
                const r = await request(`${origin}/v1/nonce`, { signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
                const text = (await r.text()).trim();
                if (!r.ok || !/^[0-9a-f]{64}$/.test(text)) throw fail("unavailable");
                return Uint8Array.from(text.match(/../g)!.map(v => parseInt(v, 16)));
            },
            signHello: (nonce, token) => current() ? native.signLogHello(nonce, token) : null,
        }, events, { allowLoopbackHttp: loopback });
    }
    /** Ordinary foreground log drive. Quiet/head/ACK/status are NOT read/Saved. */
    async driveCollection(options: { signal: AbortSignal }): Promise<void> {
        const signal = this.operationSignal(options.signal);
        this.checkCollection(signal);
        if (!this.native || !this.pump || this.adoptedEndpoint === null)
            throw fail("binding");
        // A reply can leave work that only a tick advances (an answer to a
        // pending app call, the next upload step). Keep turning while turns
        // send log calls, so a chain of steps never waits for the next timer.
        for (let turn = 0; turn < DRIVE_TURNS; turn++) {
            const sent: number = this.pump.callsSent;
            this.native.tick();
            await this.pump.pump();
            this.checkCollection(signal);
            if (this.pump?.callsSent === sent) break;
        }
    }
    /** Foreground head wake. The HTTP log has no push channel and the native core
     * queues a head only on open, failure or reconnect, so without this a running
     * session never learns another device's entries. Runs only after a quiet pump;
     * the native side refuses while a head fetch is already in flight. */
    async wakeCollectionLog(options: { signal: AbortSignal }): Promise<void> {
        const signal = this.operationSignal(options.signal);
        this.checkCollection(signal);
        if (!this.native || !this.pump || this.adoptedEndpoint === null)
            throw fail("binding");
        this.native.tick();
        if (!(await this.pump.pump()).quiet) return;
        this.checkCollection(signal);
        // Head-only fetch over the current authenticated session: no token
        // mint, reconnect, status flicker or readiness re-assessment.
        if (!this.native.requestLogHead()) return;
        await this.pump.pump();
        this.checkCollection(signal);
        this.native.tick();
    }
    /** Bounded READ-only probe through the actual typed native Query gate.
     * No status inference, write retry, key override or private grant. A warm
     * native replica may pass offline; an unreadable one remains unavailable. */
    waitForVerifiedRead(options: {
        signal: AbortSignal;
        timeoutMs?: number;
    }): Promise<void> {
        const { timeoutMs = 15000 } = options;
        const signal = this.operationSignal(options.signal);
        this.checkCollection(signal);
        if (
            !this.native ||
            !this.collectionScope ||
            this.adoptedEndpoint === null ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 15000
        )
            throw fail("binding");
        if (this.readWork)
            return this.readWork.then(() => {
                this.checkCollection(signal);
            });
        const work = this.verifyRead(signal, timeoutMs);
        this.readWork = work;
        void work
            .finally(() => {
                if (this.readWork === work) this.readWork = null;
            })
            .catch(() => {});
        return work;
    }
    private async verifyRead(
        signal: AbortSignal,
        timeoutMs: number,
    ): Promise<void> {
        const ctrl = new AbortController(),
            abort = () => ctrl.abort();
        this.readAbort = ctrl;
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeoutMs);
        let rejectAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = () => reject(fail("unavailable"));
            ctrl.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        void aborted.catch(() => {});
        this.readVerified = false;
        try {
            this.readClient = await MdbaseClient.connect({
                app: { name: "app-local-read-gate", version: "1" },
                connector: inProcessConnector(this.native!, {
                    collection: this.collectionScope!.collection,
                }),
                reconnect: false,
                signal: ctrl.signal,
            });
            this.checkCollection(signal);
            for (let round = 0; round < 32 && !ctrl.signal.aborted; round++) {
                this.native!.tick();
                if (this.pump) await Promise.race([this.pump.pump(), aborted]);
                this.checkCollection(signal);
                const observation = this.native!.observations();
                if (
                    observation.requiresReopen ||
                    observation.keyringRebuildFailed
                )
                    throw fail("recovery_required");
                try {
                    await this.readClient.query(
                        { limit: 1 },
                        undefined,
                        ctrl.signal,
                    );
                    this.checkCollection(signal);
                    if (ctrl.signal.aborted) throw fail("unavailable");
                    this.readVerified = true;
                    return;
                } catch (error) {
                    this.checkCollection(signal);
                    if (
                        !(error instanceof MdbaseError) ||
                        error.code !== "unavailable" ||
                        !this.pump ||
                        ctrl.signal.aborted
                    )
                        throw error;
                }
            }
            throw fail("unavailable");
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            ctrl.signal.removeEventListener("abort", rejectAbort);
            this.readClient?.close();
            this.readClient = null;
            this.readAbort = null;
        }
    }
    /** A data-only Worker port per attached tab, only after a genuine native typed read passed.
     * Every subsequent frame remains gated by native trust/applied/key/read.
     * Host controls, SQL/custody/log tokens and owner unlock are never RPCs. */
    /** Called when an app call may have queued log work (a write or file
     * transfer), so the collection drive runs now rather than on its timer. */
    onLogWork(listener: (() => void) | null): void {
        this.logWorkListener = listener;
    }
    attachDataFacade(channel: MessagePort): ReturnType<typeof attachAppLocalFacade>["resourceSetup"] {
        this.checkCollection(this.lifetime);
        if (
            !this.native ||
            !this.collectionScope ||
            !this.readVerified ||
            this.facades.size >= MAX_FACADES ||
            this.facades.has(channel)
        )
            throw fail("fenced");
        const scope = Object.freeze({
            ...this.collectionScope,
            isCurrent: () => {
                try {
                    this.checkCollection(this.lifetime);
                    return true;
                } catch {
                    return false;
                }
            },
        });
        const facade = attachAppLocalFacade(this.native, channel, scope, () => this.logWorkListener?.());
        this.facades.set(channel, facade);
        return facade.resourceSetup;
    }
    /** Close one tab's data facade (that tab left); the replica stays open. */
    detachDataFacade(channel: MessagePort): void {
        const facade = this.facades.get(channel);
        if (!facade) return;
        this.facades.delete(channel);
        facade.close();
    }
    /** Public tuple copy only; no key loans and no readiness claim. */
    registeredReceipt(): AppDeviceRegistrationReceipt {
        this.check(this.lifetime);
        const r = this.publicReceipt;
        if (!r) throw fail("fenced");
        return Object.freeze({
            ...r,
            signPublicKey: new Uint8Array(r.signPublicKey),
            kemPublicKey: new Uint8Array(r.kemPublicKey),
            noisePublicKey: new Uint8Array(r.noisePublicKey),
        });
    }
    close(): Promise<void> {
        this.closing = true;
        this.readVerified = false;
        this.readAbort?.abort();
        if (this.closeResult) return this.closeResult;
        let fenceFailed = false;
        for (const close of [
            () => this.readClient?.close(),
            () => { for (const facade of this.facades.values()) facade.close(); this.facades.clear(); },
            () => this.peopleMetadata?.authority.close(),
            () => this.bootstrap?.close(),
            () => this.outcome?.close(),
        ]) {
            try {
                close();
            } catch {
                fenceFailed = true;
            }
        }
        return (this.closeResult ??= (async () => {
            try {
                // Drain exact timer HTTP/IPC before native/SQL/lease shutdown.
                await Promise.all([...this.timerPorts].map(async port=>{try{await port.close();}catch{fenceFailed=true;}}));
                this.timerPorts.clear();
                const clean = await this.native?.close();
                if (this.collectionSql && clean !== true)
                    this.collectionSql.fence();
                this.authority?.close();
                await this.sqlClose?.();
                if (fenceFailed) throw fail("unavailable");
            } finally {
                this.key = null;
                this.noise = null;
                this.originalCustody?.envelope.fill(0);
                this.originalCustody = null;
                this.signIn = null;
                this.publicReceipt = null;
                this.outcomeStore?.close();
                this.noiseStore?.close();
                this.keys?.close();
                this.provider?.close();
            }
        })());
    }
}
