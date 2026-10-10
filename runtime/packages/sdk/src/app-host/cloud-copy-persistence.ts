/** Exact PUBLIC cloud-copy bootstrap outcome protection. Same original platform
 * KEK, no token/password/epoch/device secret/SAS/r, reset or automatic retry. */
import { decode, encode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";
import { collectionDisplayName } from "./collection-display-name.js";
import type { AppDeviceKeyCustodyPin } from "./device-key-custody.js";
import type { AppDeviceRegistrationReceipt } from "./wasm-runtime.js";
import type {
    AppCloudCopyBootstrapMetadata,
    AppCloudCopyBootstrapPersistence,
    AppCloudCopyOperation,
    AppCloudCopyOutcome,
} from "./cloud-copy-bootstrap.js";
export const APP_CLOUD_COPY_OUTCOME_MAX = 264 * 1024 + 256;
const MAX_PLAIN = 264 * 1024;
const bad = () =>
    new Error(
        "app cloud copy outcome unavailable; preserve storage and reopen",
    );
const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (v: Uint8Array) =>
    Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
export interface AppCloudCopyOutcomeScope extends AppDeviceKeyCustodyPin {
    readonly collection: string;
    readonly purpose: "create" | "join";
    readonly cpOrigin: string;
    readonly logOrigin: string;
    readonly assetSha256: string;
    readonly displayName?: string;
}
/** ONE exact original scope ciphertext record, atomic exact-cipher CAS. Existing
 * missing/corrupt is never fresh. Write copies borrowed bytes before resolving. */
export interface AppCloudCopyOutcomeStore {
    read(options: { signal: AbortSignal }): Promise<Uint8Array | null>;
    compareAndSet(
        expected: Uint8Array | null,
        encrypted: Uint8Array,
        options: { signal: AbortSignal },
    ): Promise<boolean>;
}
export class AppWebCloudCopyBootstrapPersistence implements AppCloudCopyBootstrapPersistence {
    private closed = false;
    private key: CryptoKey | null;
    private readonly fields: Readonly<{
        accountId: string;
        connectorId: string;
        deviceId: string;
        installationId: string;
        collection: string;
        purpose: "create" | "join";
        cpOrigin: string;
        logOrigin: string;
        assetSha256: string;
    }>;
    private readonly displayName: string | undefined;
    private readonly current: AppCloudCopyOutcomeScope["isCurrent"];
    private readonly owned: AppCloudCopyOutcomeScope["installationOwned"];
    private readonly io: Readonly<{
        read: AppCloudCopyOutcomeStore["read"];
        cas: AppCloudCopyOutcomeStore["compareAndSet"];
    }>;
    private readonly keys: readonly Uint8Array[];
    private readonly aad: Uint8Array;
    private readonly mode: "fresh" | "existing";
    private readonly lifetime: AbortSignal;
    constructor(
        private readonly source: AppCloudCopyOutcomeScope,
        receipt: AppDeviceRegistrationReceipt,
        key: CryptoKey,
        private readonly store: AppCloudCopyOutcomeStore,
        options: { mode: "fresh" | "existing"; signal: AbortSignal },
    ) {
        this.key = key;
        try {
            this.mode = options.mode;
            this.lifetime = options.signal;
            this.fields = Object.freeze({
                accountId: source.accountId,
                connectorId: source.connectorId,
                deviceId: source.deviceId,
                installationId: source.installationId,
                collection: source.collection,
                purpose: source.purpose,
                cpOrigin: source.cpOrigin,
                logOrigin: source.logOrigin,
                assetSha256: source.assetSha256,
            });
            const requestedName = source.displayName;
            this.displayName = requestedName === undefined ? undefined : collectionDisplayName(requestedName);
            if ((this.displayName !== undefined && source.purpose !== "create") || requestedName !== this.displayName) throw bad();
            this.current = source.isCurrent;
            this.owned = source.installationOwned;
            this.io = Object.freeze({
                read: store.read,
                cas: store.compareAndSet,
            });
            const ids = [
                source.accountId,
                source.connectorId,
                source.deviceId,
                source.installationId,
                source.collection,
            ].map(uuidToBytes);
            if (
                ids.some((v) => v.every((b) => b === 0)) ||
                !["create", "join"].includes(source.purpose) ||
                !["fresh", "existing"].includes(this.mode) ||
                !/^[0-9a-f]{64}$/.test(source.assetSha256)
            )
                throw bad();
            this.keys = Object.freeze(
                [
                    receipt.signPublicKey,
                    receipt.kemPublicKey,
                    receipt.noisePublicKey,
                ].map((v) => {
                    if (
                        !(v instanceof Uint8Array) ||
                        v.length !== 32 ||
                        v.every((b) => b === 0)
                    )
                        throw bad();
                    return new Uint8Array(v);
                }),
            );
            if (
                receipt.connectorId !== source.connectorId ||
                receipt.deviceId !== source.deviceId ||
                receipt.installationId !== source.installationId
            )
                throw bad();
            if (
                typeof globalThis.CryptoKey !== "function" ||
                !(key instanceof CryptoKey) ||
                key.type !== "secret" ||
                key.extractable ||
                key.algorithm.name !== "AES-GCM" ||
                (key.algorithm as AesKeyAlgorithm).length !== 256 ||
                key.usages.length !== 2 ||
                !key.usages.includes("encrypt") ||
                !key.usages.includes("decrypt")
            )
                throw bad();
            // Full operation/trust/public tuple bound before ANY asynchronous IO/crypto.
            this.aad = encode([
                "mdbase/v1/app-cloud-copy-outcome-platform",
                ...ids,
                source.purpose,
                source.cpOrigin,
                source.logOrigin,
                source.assetSha256,
                ...this.keys,
            ]);
            this.check(this.lifetime);
        } catch {
            throw bad();
        }
    }
    private check(signal: AbortSignal): void {
        try {
            if (
                this.closed ||
                !this.key ||
                signal !== this.lifetime ||
                signal.aborted ||
                this.source.displayName !== this.displayName ||
                this.source.isCurrent !== this.current ||
                this.source.installationOwned !== this.owned ||
                this.current.call(this.source) !== true ||
                this.owned.call(this.source) !== true ||
                this.store.read !== this.io.read ||
                this.store.compareAndSet !== this.io.cas ||
                Object.entries(this.fields).some(
                    ([k, v]) =>
                        this.source[k as keyof AppCloudCopyOutcomeScope] !== v,
                )
            )
                throw bad();
        } catch {
            throw bad();
        }
    }
    private operation(value?: AppCloudCopyOperation): AppCloudCopyOperation {
        if (value) {
            if (value.displayName !== this.displayName) throw bad();
            for (const k of Object.keys(
                this.fields,
            ) as (keyof typeof this.fields)[])
                if (value[k] !== this.fields[k]) throw bad();
            for (const [i, k] of [
                "signPublicKey",
                "kemPublicKey",
                "noisePublicKey",
            ].entries())
                if (
                    !(
                        value[k as keyof AppCloudCopyOperation] instanceof
                        Uint8Array
                    ) ||
                    !same(value[k as "signPublicKey"], this.keys[i]!)
                )
                    throw bad();
        }
        return Object.freeze({
            ...this.fields,
            ...(this.displayName === undefined ? {} : {displayName: this.displayName}),
            signPublicKey: new Uint8Array(this.keys[0]!),
            kemPublicKey: new Uint8Array(this.keys[1]!),
            noisePublicKey: new Uint8Array(this.keys[2]!),
        });
    }
    private metadata(
        value: AppCloudCopyBootstrapMetadata,
    ): AppCloudCopyBootstrapMetadata {
        const operation = this.operation(value.operation);
        if (
            !(value.genesisItem instanceof Uint8Array) ||
            !value.genesisItem.length ||
            value.genesisItem.length > 256 * 1024 ||
            typeof value.expectedGenesis !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(value.expectedGenesis)
        )
            throw bad();
        return Object.freeze({
            operation,
            genesisItem: new Uint8Array(value.genesisItem),
            expectedGenesis: value.expectedGenesis,
        });
    }
    private async hashChecked(
        metadata: AppCloudCopyBootstrapMetadata,
        signal: AbortSignal,
    ): Promise<void> {
        const domain = new TextEncoder().encode("mdbase/v1/chain"),
            input = new Uint8Array(
                1 + domain.length + metadata.genesisItem.length,
            );
        input[0] = domain.length;
        input.set(domain, 1);
        input.set(metadata.genesisItem, 1 + domain.length);
        const digest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", input),
        );
        this.check(signal);
        if (metadata.expectedGenesis !== `sha256:${hex(digest)}`) throw bad();
    }
    private async read(
        signal: AbortSignal,
    ): Promise<{
        encrypted: Uint8Array;
        metadata: AppCloudCopyBootstrapMetadata | null;
    } | null> {
        let plain: Uint8Array | null = null;
        try {
            this.check(signal);
            const borrowed = await this.io.read.call(
                this.store,
                Object.freeze({ signal }),
            );
            this.check(signal);
            if (borrowed === null) {
                if (this.mode !== "fresh") throw bad();
                return null;
            }
            if (
                !(borrowed instanceof Uint8Array) ||
                !borrowed.length ||
                borrowed.length > APP_CLOUD_COPY_OUTCOME_MAX
            )
                throw bad();
            const encrypted = new Uint8Array(borrowed),
                decodedOuter = decode(encrypted);
            if (!(decodedOuter instanceof Map)) throw bad();
            const outer = decodedOuter as Map<CborValue, CborValue>;
            if (outer.size !== 3 || outer.get(0) !== 1) throw bad();
            const iv = outer.get(1),
                body = outer.get(2);
            if (
                !(iv instanceof Uint8Array) ||
                iv.length !== 12 ||
                !(body instanceof Uint8Array) ||
                body.length < 16 ||
                body.length > MAX_PLAIN + 16
            )
                throw bad();
            plain = new Uint8Array(
                await crypto.subtle.decrypt(
                    {
                        name: "AES-GCM",
                        iv: new Uint8Array(iv),
                        additionalData: new Uint8Array(this.aad),
                        tagLength: 128,
                    },
                    this.key!,
                    new Uint8Array(body),
                ),
            );
            this.check(signal);
            if (plain.length > MAX_PLAIN) throw bad();
            const decodedRecord = decode(plain);
            if (!(decodedRecord instanceof Map)) throw bad();
            const record = decodedRecord as Map<CborValue, CborValue>;
            // Preserve legacy omitted-name outcomes; never reinterpret them as
            // an explicitly supplied default or let retries change a label.
            const legacy = record.get(0) === 1 && record.size === 3;
            if (!legacy && !(record.get(0) === 2 && record.size === 4)) throw bad();
            if ((legacy ? null : record.get(3)) !== (this.displayName ?? null)) throw bad();
            const keys = record.get(1);
            if (
                !Array.isArray(keys) ||
                keys.length !== 3 ||
                keys.some(
                    (v, i) =>
                        !(v instanceof Uint8Array) || !same(v, this.keys[i]!),
                )
            )
                throw bad();
            const raw = record.get(2);
            let metadata: AppCloudCopyBootstrapMetadata | null = null;
            if (raw !== null) {
                if (
                    !Array.isArray(raw) ||
                    raw.length !== 2 ||
                    !(raw[0] instanceof Uint8Array) ||
                    typeof raw[1] !== "string"
                )
                    throw bad();
                metadata = this.metadata({
                    operation: this.operation(),
                    genesisItem: raw[0],
                    expectedGenesis: raw[1],
                });
                await this.hashChecked(metadata, signal);
            }
            return { encrypted, metadata };
        } catch {
            throw bad();
        } finally {
            plain?.fill(0);
        }
    }
    private async write(
        metadata: AppCloudCopyBootstrapMetadata | null,
        expected: Uint8Array | null,
        signal: AbortSignal,
    ): Promise<void> {
        let plain: Uint8Array | null = null,
            cipher: Uint8Array | null = null;
        try {
            this.check(signal);
            plain = encode(
                new Map<number, CborValue>([
                    [0, 2],
                    [1, this.keys.map((v) => new Uint8Array(v))],
                    [
                        2,
                        metadata === null
                            ? null
                            : [metadata.genesisItem, metadata.expectedGenesis],
                    ],
                    [3, this.displayName ?? null],
                ]),
            );
            if (plain.length > MAX_PLAIN) throw bad();
            const iv = crypto.getRandomValues(new Uint8Array(12)),
                body = new Uint8Array(
                    await crypto.subtle.encrypt(
                        {
                            name: "AES-GCM",
                            iv,
                            additionalData: new Uint8Array(this.aad),
                            tagLength: 128,
                        },
                        this.key!,
                        new Uint8Array(plain),
                    ),
                );
            this.check(signal);
            cipher = encode(
                new Map<number, CborValue>([
                    [0, 1],
                    [1, iv],
                    [2, body],
                ]),
            );
            if (cipher.length > APP_CLOUD_COPY_OUTCOME_MAX) throw bad();
            const confirmed = await this.io.cas.call(
                this.store,
                expected,
                cipher,
                Object.freeze({ signal }),
            );
            this.check(signal);
            if (confirmed !== true) throw bad();
        } catch {
            throw bad();
        } finally {
            plain?.fill(0);
            cipher?.fill(0);
        }
    }
    async restore(options: {
        signal: AbortSignal;
    }): Promise<AppCloudCopyOutcome> {
        const { signal } = options;
        const existing = await this.read(signal);
        this.check(signal);
        return existing === null
            ? Object.freeze({ state: "none" })
            : existing.metadata === null
              ? Object.freeze({ state: "pending", operation: this.operation() })
              : Object.freeze({
                    state: "completed",
                    metadata: this.metadata(existing.metadata),
                });
    }
    async pending(
        operation: AppCloudCopyOperation,
        options: { signal: AbortSignal },
    ): Promise<void> {
        const { signal } = options;
        this.check(signal);
        this.operation(operation);
        const existing = await this.read(signal);
        this.check(signal);
        if (existing) return;
        await this.write(null, null, signal);
    }
    async completed(
        metadata: AppCloudCopyBootstrapMetadata,
        options: { signal: AbortSignal },
    ): Promise<void> {
        const { signal } = options;
        this.check(signal);
        const owned = this.metadata(metadata);
        await this.hashChecked(owned, signal);
        const existing = await this.read(signal);
        this.check(signal);
        if (!existing) throw bad();
        if (existing.metadata) {
            if (
                !same(existing.metadata.genesisItem, owned.genesisItem) ||
                existing.metadata.expectedGenesis !== owned.expectedGenesis
            )
                throw bad();
            return;
        }
        await this.write(owned, existing.encrypted, signal);
    }
    close(): void {
        this.closed = true;
        this.key = null;
    }
}
