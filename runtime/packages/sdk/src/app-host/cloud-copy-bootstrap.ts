/** First-party original-device CLOUD COPY HTTP bootstrap. No hosted-first,
 * seed loan, generic signer, runtime roots/keys discovery or readiness inference. */
import { uuidToBytes } from "../codec.js";
import { collectionDisplayName } from "./collection-display-name.js";
import type { AppDeviceKeyCustodyPin } from "./device-key-custody.js";
import type {
    AppCloudCopyCollectionPin,
    AppDeviceRegistrationReceipt,
    AppCollectionBootstrap,
    AppSqlLifetime,
    AppWasmRuntime,
} from "./wasm-runtime.js";
/** Static public output of the ONE shared BUILD verifier, bundled by the release.
 * Authenticating this manifest/tool MUST precede constructing the trusted host. */
export interface AppBundledReleaseTrust {
    readonly schema: "mdbn-app-trust/release/1";
    readonly environment: string;
    readonly cpOrigin: string;
    readonly logOrigin: string;
    readonly assetSha256: string;
    readonly source: Readonly<{
        repository: string;
        commit: string;
        version: string;
    }>;
    readonly trustedRoots: readonly Uint8Array[];
    readonly policyPins: Uint8Array;
}
export interface AppCpCloudCopySession
    extends AppCloudCopyCollectionPin, AppDeviceKeyCustodyPin {
    readonly cpOrigin: string;
    readonly logOrigin: string;
    connectorBearer(options: { signal: AbortSignal }): Promise<string>;
}
export interface AppCloudCopyOperation extends AppDeviceRegistrationReceipt {
    readonly accountId: string;
    readonly collection: string;
    readonly purpose: "create" | "join";
    /** Original normalized create label; absent means the original omitted intent. */
    readonly displayName?: string;
    readonly assetSha256: string;
    readonly cpOrigin: string;
    readonly logOrigin: string;
}
export interface AppCloudCopyBootstrapMetadata {
    readonly operation: AppCloudCopyOperation;
    readonly genesisItem: Uint8Array;
    readonly expectedGenesis: string;
}
export type AppCloudCopyAdoptionOptions = Pick<
    AppCollectionBootstrap,
    "replicaId" | "endpoint" | "opened" | "sqliteVersion"
> & { readonly signal: AbortSignal; readonly cloudCopyOptIn: true };
export type AppCloudCopyOutcome =
    | { readonly state: "none" }
    | { readonly state: "pending"; readonly operation: AppCloudCopyOperation }
    | {
          readonly state: "completed";
          readonly metadata: AppCloudCopyBootstrapMetadata;
      };
/** Protected exact public outcome CAS. Missing/corrupt existing is NOT none;
 * pending/completion resolves only after confirmed preservation, no reset/delete. */
export interface AppCloudCopyBootstrapPersistence {
    restore(options: { signal: AbortSignal }): Promise<AppCloudCopyOutcome>;
    pending(
        operation: AppCloudCopyOperation,
        options: { signal: AbortSignal },
    ): Promise<void>;
    completed(
        metadata: AppCloudCopyBootstrapMetadata,
        options: { signal: AbortSignal },
    ): Promise<void>;
}
export class AppCloudCopyBootstrapError extends Error {
    constructor(
        readonly reason:
            | "binding"
            | "fenced"
            | "unavailable"
            | "response"
            | "outcome_unknown",
    ) {
        super(`app cloud copy bootstrap: ${reason}`);
        this.name = "AppCloudCopyBootstrapError";
    }
}
const fail = (r: AppCloudCopyBootstrapError["reason"]) =>
    new AppCloudCopyBootstrapError(r);
const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (v: Uint8Array) =>
    Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
function bytes(v: unknown, max: number): Uint8Array {
    if (
        typeof v !== "string" ||
        !v.length ||
        v.length % 2 ||
        v.length > max * 2 ||
        !/^[0-9a-f]+$/.test(v)
    )
        throw fail("response");
    return Uint8Array.from(v.match(/../g)!, (v) => parseInt(v, 16));
}
function object(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw fail("response");
    return v as Record<string, unknown>;
}
export class AppCpCloudCopyBootstrap {
    private attempted = false;
    private adopted = false;
    private originalSignal: AbortSignal | null = null;
    private completion: AppCloudCopyBootstrapMetadata | null = null;
    private readonly lifetime = new AbortController();
    private readonly scope: Readonly<{
        accountId: string;
        connectorId: string;
        deviceId: string;
        installationId: string;
        collection: string;
        purpose: "create" | "join";
        cpOrigin: string;
        logOrigin: string;
    }>;
    private readonly callbacks: Readonly<{
        current: AppCpCloudCopySession["isCurrent"];
        owned: AppCpCloudCopySession["installationOwned"];
        bearer: AppCpCloudCopySession["connectorBearer"];
    }>;
    private readonly trustFields: Readonly<{
        schema: string;
        environment: string;
        assetSha256: string;
        repository: string;
        commit: string;
        version: string;
    }>;
    private readonly roots: readonly Uint8Array[];
    private readonly pins: Uint8Array;
    private readonly operation: AppCloudCopyOperation;
    private readonly storageCallbacks: Readonly<{
        restore: AppCloudCopyBootstrapPersistence["restore"];
        pending: AppCloudCopyBootstrapPersistence["pending"];
        completed: AppCloudCopyBootstrapPersistence["completed"];
    }>;
    private readonly request: typeof fetch;
    private readonly now: () => number;
    private readonly loopback: boolean;
    constructor(
        private readonly runtime: AppWasmRuntime,
        private readonly session: AppCpCloudCopySession,
        private readonly trust: AppBundledReleaseTrust,
        private readonly persistence: AppCloudCopyBootstrapPersistence,
        options: {
            fetch?: typeof fetch;
            now?: () => number;
            allowLoopbackHttp?: boolean;
            /** Cleartext catalog label. Explicit create only; never a local alias. */
            displayName?: string;
        } = {},
    ) {
        try {
            this.storageCallbacks = Object.freeze({
                restore: persistence.restore,
                pending: persistence.pending,
                completed: persistence.completed,
            });
            this.scope = Object.freeze({
                accountId: session.accountId,
                connectorId: session.connectorId,
                deviceId: session.deviceId,
                installationId: session.installationId,
                collection: session.collection,
                purpose: session.purpose,
                cpOrigin: session.cpOrigin,
                logOrigin: session.logOrigin,
            });
            this.callbacks = Object.freeze({
                current: session.isCurrent,
                owned: session.installationOwned,
                bearer: session.connectorBearer,
            });
            this.loopback = options.allowLoopbackHttp === true;
            for (const v of [
                this.scope.accountId,
                this.scope.connectorId,
                this.scope.deviceId,
                this.scope.installationId,
                this.scope.collection,
            ])
                if (uuidToBytes(v).every((v) => v === 0)) throw fail("binding");
            this.origin(this.scope.cpOrigin);
            this.origin(this.scope.logOrigin);
            if (
                trust.schema !== "mdbn-app-trust/release/1" ||
                !(
                    ["lab", "staging", "production"].includes(
                        trust.environment,
                    ) ||
                    (this.loopback && trust.environment === "test")
                ) ||
                trust.cpOrigin !== this.scope.cpOrigin ||
                trust.logOrigin !== this.scope.logOrigin ||
                !/^[0-9a-f]{64}$/.test(trust.assetSha256) ||
                trust.source.repository !== "mdbase-dev/mdbase-connect" ||
                !/^[0-9a-f]{40}$/.test(trust.source.commit) ||
                !trust.source.version ||
                trust.source.version.length > 64 ||
                !Array.isArray(trust.trustedRoots) ||
                trust.trustedRoots.length < 1 ||
                trust.trustedRoots.length > 64 ||
                !(trust.policyPins instanceof Uint8Array) ||
                !trust.policyPins.length ||
                trust.policyPins.length > 65536
            )
                throw fail("binding");
            this.trustFields = Object.freeze({
                schema: trust.schema,
                environment: trust.environment,
                assetSha256: trust.assetSha256,
                ...trust.source,
            });
            this.roots = Object.freeze(
                trust.trustedRoots.map((v) => {
                    if (
                        !(v instanceof Uint8Array) ||
                        v.length !== 32 ||
                        v.every((v) => v === 0)
                    )
                        throw fail("binding");
                    return new Uint8Array(v);
                }),
            );
            this.pins = new Uint8Array(trust.policyPins);
            const requestedName = options.displayName;
            const displayName = requestedName === undefined ? undefined : collectionDisplayName(requestedName);
            if (displayName !== undefined && this.scope.purpose !== "create") throw fail("binding");
            this.operation = Object.freeze({
                ...runtime.registeredDeviceReceipt(),
                ...(displayName === undefined ? {} : {displayName}),
                accountId: this.scope.accountId,
                collection: this.scope.collection,
                purpose: this.scope.purpose,
                assetSha256: trust.assetSha256,
                cpOrigin: this.scope.cpOrigin,
                logOrigin: this.scope.logOrigin,
            });
            this.request = options.fetch ?? globalThis.fetch;
            this.now = options.now ?? Date.now;
            if (!this.current()) throw fail("binding");
        } catch {
            runtime.retireLog();
            throw fail("binding");
        }
    }
    private origin(raw: string): string {
        const u = new URL(raw);
        if (
            u.origin !== raw ||
            u.username ||
            u.password ||
            (u.protocol !== "https:" &&
                !(
                    this.loopback &&
                    u.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
                ))
        )
            throw fail("binding");
        return u.origin;
    }
    private current(): boolean {
        try {
            const s = this.session,
                t = this.trust,
                f = this.trustFields;
            return (
                !this.lifetime.signal.aborted &&
                !this.originalSignal?.aborted &&
                (this.adopted || this.runtime.cloudCopyCollectionCurrent(s)) &&
                this.persistence.restore === this.storageCallbacks.restore &&
                this.persistence.pending === this.storageCallbacks.pending &&
                this.persistence.completed ===
                    this.storageCallbacks.completed &&
                s.isCurrent === this.callbacks.current &&
                s.installationOwned === this.callbacks.owned &&
                s.connectorBearer === this.callbacks.bearer &&
                this.callbacks.current.call(s) === true &&
                this.callbacks.owned.call(s) === true &&
                Object.entries(this.scope).every(
                    ([k, v]) => s[k as keyof AppCpCloudCopySession] === v,
                ) &&
                t.cpOrigin === this.scope.cpOrigin &&
                t.logOrigin === this.scope.logOrigin &&
                t.schema === f.schema &&
                t.environment === f.environment &&
                t.assetSha256 === f.assetSha256 &&
                t.source.repository === f.repository &&
                t.source.commit === f.commit &&
                t.source.version === f.version &&
                t.trustedRoots.length === this.roots.length &&
                t.trustedRoots.every((v, i) => equal(v, this.roots[i]!)) &&
                equal(t.policyPins, this.pins)
            );
        } catch {
            return false;
        }
    }
    private check(signal: AbortSignal): void {
        if (signal.aborted || !this.current()) {
            this.close();
            throw fail("fenced");
        }
    }
    private operationCopy(value: AppCloudCopyOperation): AppCloudCopyOperation {
        for (const k of [
            "accountId",
            "connectorId",
            "deviceId",
            "installationId",
            "collection",
            "purpose",
            "cpOrigin",
            "logOrigin",
            "assetSha256",
            "displayName",
        ] as const)
            if (value[k] !== this.operation[k]) throw fail("response");
        for (const k of [
            "signPublicKey",
            "kemPublicKey",
            "noisePublicKey",
        ] as const)
            if (
                !(value[k] instanceof Uint8Array) ||
                !equal(value[k], this.operation[k])
            )
                throw fail("response");
        return Object.freeze({
            ...this.operation,
            signPublicKey: new Uint8Array(this.operation.signPublicKey),
            kemPublicKey: new Uint8Array(this.operation.kemPublicKey),
            noisePublicKey: new Uint8Array(this.operation.noisePublicKey),
        });
    }
    private copy(
        value: AppCloudCopyBootstrapMetadata,
    ): AppCloudCopyBootstrapMetadata {
        if (
            !(value.genesisItem instanceof Uint8Array) ||
            !value.genesisItem.length ||
            value.genesisItem.length > 256 * 1024 ||
            !/^sha256:[0-9a-f]{64}$/.test(value.expectedGenesis)
        )
            throw fail("response");
        return Object.freeze({
            operation: this.operationCopy(value.operation),
            genesisItem: new Uint8Array(value.genesisItem),
            expectedGenesis: value.expectedGenesis,
        });
    }
    private async hash(item: Uint8Array, signal: AbortSignal): Promise<string> {
        const d = new TextEncoder().encode("mdbase/v1/chain"),
            input = new Uint8Array(1 + d.length + item.length);
        input[0] = d.length;
        input.set(d, 1);
        input.set(item, 1 + d.length);
        const result = new Uint8Array(
            await crypto.subtle.digest("SHA-256", input),
        );
        this.check(signal);
        return `sha256:${hex(result)}`;
    }
    private async json(
        path: string,
        bearer: string,
        body: string | undefined,
        signal: AbortSignal,
    ): Promise<Record<string, unknown>> {
        this.check(signal);
        const ctrl = new AbortController(),
            abort = () => ctrl.abort(),
            timer = setTimeout(abort, 15000);
        (timer as { unref?: () => void }).unref?.();
        signal.addEventListener("abort", abort, { once: true });
        this.lifetime.signal.addEventListener("abort", abort, { once: true });
        const buffer = new Uint8Array(1024 * 1024);
        let count = 0,
            response: Response | null = null,
            reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
            // Browser/Workers native fetch must not receive the host as `this`.
            const fetchImpl = this.request;
            response = await fetchImpl(`${this.scope.cpOrigin}${path}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${bearer}`,
                    ...(body === undefined
                        ? {}
                        : { "content-type": "application/json" }),
                },
                body,
                signal: ctrl.signal,
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                referrerPolicy: "no-referrer",
            });
            this.check(signal);
            if (ctrl.signal.aborted || !response.ok) throw fail("unavailable");
            // Fetch decodes content-encoding (which CORS may hide). The
            // decoded stream, not wire Content-Length, enforces the hard cap.
            const length = response.headers.get("content-length");
            if (length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number(length) > buffer.length) {
                ctrl.abort();
                throw fail("response");
            }
            if (!response.body) throw fail("response");
            reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                try {
                    this.check(signal);
                    if (ctrl.signal.aborted) throw fail("unavailable");
                    if (done) break;
                    if (count + value.length > buffer.length) {
                        ctrl.abort();
                        throw fail("response");
                    }
                    buffer.set(value, count);
                    count += value.length;
                } finally {
                    value?.fill(0);
                }
            }
            return object(
                JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                        buffer.subarray(0, count),
                    ),
                ),
            );
        } catch (e) {
            this.check(signal);
            if (e instanceof AppCloudCopyBootstrapError) throw e;
            throw fail("unavailable");
        } finally {
            buffer.fill(0);
            void (reader?.cancel() ?? response?.body?.cancel())?.catch(
                () => {},
            );
            reader?.releaseLock();
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            this.lifetime.signal.removeEventListener("abort", abort);
        }
    }
    /** One attempt; pending unknown never rePOSTs without explicit host recovery.
     * Completion restoration precedes bearer/challenge/proof/HTTP. No readiness. */
    async bootstrap(options: {
        signal: AbortSignal;
        reconcile?: "explicit-unknown-outcome";
    }): Promise<AppCloudCopyBootstrapMetadata> {
        const { signal, reconcile } = options;
        const call = Object.freeze({ signal });
        let nonce: Uint8Array | null = null,
            signature: Uint8Array | null = null;
        try {
            this.originalSignal ??= signal;
            if (signal !== this.originalSignal) throw fail("fenced");
            this.check(signal);
            if (this.attempted) throw fail("fenced");
            this.attempted = true;
            const restored = await this.storageCallbacks.restore.call(
                this.persistence,
                call,
            );
            this.check(signal);
            if (restored.state === "completed") {
                const copy = this.copy(restored.metadata);
                if (
                    (await this.hash(copy.genesisItem, signal)) !==
                    copy.expectedGenesis
                )
                    throw fail("response");
                this.completion = this.copy(copy);
                return copy;
            }
            if (restored.state === "pending") {
                this.operationCopy(restored.operation);
                if (reconcile !== "explicit-unknown-outcome")
                    throw fail("outcome_unknown");
            } else if (restored.state !== "none") throw fail("response");
            await this.storageCallbacks.pending.call(
                this.persistence,
                this.operationCopy(this.operation),
                call,
            );
            this.check(signal);
            const bearer = await this.callbacks.bearer.call(this.session, call);
            this.check(signal);
            if (
                typeof bearer !== "string" ||
                !bearer ||
                bearer.length > 16384 ||
                /[^\x21-\x7e]/.test(bearer)
            )
                throw fail("binding");
            const challenge = await this.json(
                "/v1/next/devices/challenge",
                bearer,
                undefined,
                signal,
            );
            nonce = bytes(challenge.challenge, 32);
            if (
                nonce.length !== 32 ||
                typeof challenge.expires_at !== "number" ||
                !Number.isSafeInteger(challenge.expires_at) ||
                challenge.expires_at - this.now() <= 5000 ||
                challenge.expires_at - this.now() > 16 * 60000
            )
                throw fail("response");
            const create = this.scope.purpose === "create";
            signature = create
                ? this.runtime.signCloudCopyCreate(nonce)
                : this.runtime.signCloudCopyJoin(nonce);
            this.check(signal);
            if (signature.length !== 64) throw fail("response");
            const result = await this.json(
                create
                    ? "/v1/next/collections/cloud-copy"
                    : `/v1/next/collections/${this.scope.collection}/devices`,
                bearer,
                JSON.stringify({
                    device_id: this.scope.deviceId,
                    challenge: challenge.challenge,
                    sig: hex(signature),
                    ...(create ? { collection_id: this.scope.collection, ...(this.operation.displayName === undefined ? {} : {display_name: this.operation.displayName}) } : {}),
                }),
                signal,
            );
            if (
                result.collection_id !== this.scope.collection ||
                result.log_url !== this.scope.logOrigin
            )
                throw fail("response");
            if (create) {
                const root = bytes(result.root_public_key, 32);
                if (
                    result.state !== "cloud-copy" ||
                    result.owner_account !== this.scope.accountId ||
                    !this.roots.some((v) => equal(v, root))
                )
                    throw fail("response");
            } else if (
                typeof result.enrolled_at !== "number" ||
                !Number.isSafeInteger(result.enrolled_at) ||
                result.enrolled_at < 1
            )
                throw fail("response");
            const device = object(result.device);
            if (
                device.device_id !== this.scope.deviceId ||
                typeof device.token !== "string" ||
                !device.token ||
                device.token.length > 16384 ||
                /[^\x21-\x7e]/.test(device.token) ||
                typeof device.expires_at !== "number" ||
                !Number.isSafeInteger(device.expires_at) ||
                device.expires_at - this.now() <= 5000 ||
                device.expires_at - this.now() > 16 * 60000
            )
                throw fail("response");
            const genesis = object(result.genesis);
            if (genesis.seq !== 1) throw fail("response");
            const item = bytes(genesis.item, 256 * 1024),
                metadata = this.copy({
                    operation: this.operation,
                    genesisItem: item,
                    expectedGenesis: await this.hash(item, signal),
                });
            // Token/head/recipient lists are NOT stored/adopted as authority/readiness.
            await this.storageCallbacks.completed.call(
                this.persistence,
                this.copy(metadata),
                call,
            );
            this.check(signal);
            this.completion = this.copy(metadata);
            return metadata;
        } catch (e) {
            this.close();
            if (e instanceof AppCloudCopyBootstrapError) throw e;
            throw fail("unavailable");
        } finally {
            nonce?.fill(0);
            signature?.fill(0);
        }
    }
    /** Synchronous SAME-bundle adoption only after confirmed bootstrap. No
     * caller metadata/roots/pins/state override or seed loan. Still not readable. */
    adoptCollection(
        options: AppCloudCopyAdoptionOptions,
        sql: AppSqlLifetime,
    ): void {
        const {
            signal,
            replicaId,
            endpoint,
            opened,
            sqliteVersion,
            cloudCopyOptIn,
        } = options;
        try {
            this.check(signal);
            if (
                this.adopted ||
                !this.completion ||
                signal !== this.originalSignal ||
                cloudCopyOptIn !== true
            )
                throw fail("binding");
            const config: AppCollectionBootstrap = {
                replicaId,
                endpoint,
                opened,
                sqliteVersion,
                collection: this.scope.collection,
                deviceId: this.scope.deviceId,
                state: "cloud_copy",
                cloudCopyOptIn: true,
                trustedRoots: this.roots.map((v) => new Uint8Array(v)),
                policyPins: new Uint8Array(this.pins),
                trustedSigners: [],
                expectedGenesis: this.completion.expectedGenesis,
            };
            this.runtime.adoptDevice(config, sql);
            this.adopted = true;
            this.check(signal);
        } catch (e) {
            this.close();
            if (e instanceof AppCloudCopyBootstrapError) throw e;
            throw fail("unavailable");
        }
    }
    close(): void {
        this.completion = null;
        this.lifetime.abort();
        this.runtime.retireLog();
    }
}
