/** ONE exact scoped cloud-copy outcome ciphertext record. No generic KV,
 * delete/reset/retry, secret fields or missing-existing -> fresh fallback. */
import { uuidToBytes } from "../codec.js";
import {
    APP_CLOUD_COPY_OUTCOME_MAX,
    type AppCloudCopyOutcomeScope,
    type AppCloudCopyOutcomeStore,
} from "./cloud-copy-persistence.js";
const STORE = "public-outcome",
    KEY = "operation";
const bad = () =>
    new Error(
        "app cloud copy outcome store unavailable; preserve storage and reopen",
    );
const same = (a: Uint8Array | null, b: Uint8Array | null) =>
    a === null || b === null
        ? a === b
        : a.length === b.length && a.every((v, i) => v === b[i]);
function bytes(value: unknown): Uint8Array {
    if (
        !(value instanceof Uint8Array) ||
        !value.length ||
        value.length > APP_CLOUD_COPY_OUTCOME_MAX
    )
        throw bad();
    return new Uint8Array(value);
}
export interface AppIndexedDbCloudCopyOutcomeOptions {
    readonly source: AppCloudCopyOutcomeScope;
    readonly origin: string;
    readonly mode: "fresh" | "existing";
    readonly signal: AbortSignal;
    readonly allowLoopbackHttp?: boolean;
}
export class AppIndexedDbCloudCopyOutcomeStore implements AppCloudCopyOutcomeStore {
    private db: IDBDatabase | null = null;
    private closed = false;
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
    private readonly current: AppCloudCopyOutcomeScope["isCurrent"];
    private readonly owned: AppCloudCopyOutcomeScope["installationOwned"];
    private constructor(
        private readonly source: AppCloudCopyOutcomeScope,
        private readonly origin: string,
        private readonly lifetime: AbortSignal,
    ) {
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
        this.current = source.isCurrent;
        this.owned = source.installationOwned;
    }
    /** Terminal handle health only, not ownership/readiness/durability authority. */
    get fenced(): boolean {
        return this.closed || this.lifetime.aborted;
    }
    private check(signal: AbortSignal): void {
        try {
            if (
                this.fenced ||
                signal !== this.lifetime ||
                signal.aborted ||
                globalThis.location?.origin !== this.origin ||
                this.source.isCurrent !== this.current ||
                this.source.installationOwned !== this.owned ||
                this.current.call(this.source) !== true ||
                this.owned.call(this.source) !== true ||
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
    static async open(
        options: AppIndexedDbCloudCopyOutcomeOptions,
    ): Promise<AppIndexedDbCloudCopyOutcomeStore> {
        const { source, origin, mode, signal, allowLoopbackHttp } = options;
        let out: AppIndexedDbCloudCopyOutcomeStore | null = null;
        try {
            out = new AppIndexedDbCloudCopyOutcomeStore(source, origin, signal);
            const ids = [
                out.fields.accountId,
                out.fields.connectorId,
                out.fields.deviceId,
                out.fields.installationId,
                out.fields.collection,
            ].map((id) => {
                if (uuidToBytes(id).every((v) => v === 0)) throw bad();
                return id.toLowerCase();
            });
            const u = new URL(origin),
                loopback =
                    allowLoopbackHttp === true &&
                    u.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
            if (
                (u.protocol !== "https:" && !loopback) ||
                u.origin !== origin ||
                u.username ||
                u.password ||
                !["fresh", "existing"].includes(mode) ||
                !["create", "join"].includes(out.fields.purpose) ||
                !/^[0-9a-f]{64}$/.test(out.fields.assetSha256) ||
                !globalThis.indexedDB
            )
                throw bad();
            out.check(signal);
            out.db = await out.openDatabase(
                `mdbase.app.cloud-copy-outcome.v1.${ids.join(".")}.${out.fields.purpose}`,
                mode,
            );
            out.db.onversionchange = () => out!.close();
            out.check(signal);
            const existing = await out.read(Object.freeze({ signal }));
            try {
                if ((mode === "fresh") !== (existing === null)) throw bad();
                out.check(signal);
            } finally {
                existing?.fill(0);
            }
            return out;
        } catch {
            out?.close();
            throw bad();
        }
    }
    private openDatabase(
        name: string,
        mode: "fresh" | "existing",
    ): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            this.check(this.lifetime);
            const request = indexedDB.open(name, 1);
            let abandoned = false,
                created = false;
            const stop = () => {
                    abandoned = true;
                    reject(bad());
                },
                finish = () => this.lifetime.removeEventListener("abort", stop);
            this.lifetime.addEventListener("abort", stop, { once: true });
            request.onblocked = stop;
            request.onupgradeneeded = () => {
                try {
                    this.check(this.lifetime);
                    if (
                        abandoned ||
                        mode !== "fresh" ||
                        request.result.objectStoreNames.length !== 0
                    )
                        throw bad();
                    request.result.createObjectStore(STORE);
                    created = true;
                } catch {
                    request.transaction?.abort();
                }
            };
            request.onerror = () => {
                finish();
                reject(bad());
            };
            request.onsuccess = () => {
                finish();
                try {
                    this.check(this.lifetime);
                    if (
                        abandoned ||
                        (mode === "fresh" && !created) ||
                        request.result.objectStoreNames.length !== 1 ||
                        !request.result.objectStoreNames.contains(STORE)
                    )
                        throw bad();
                    resolve(request.result);
                } catch {
                    request.result.close();
                    reject(bad());
                }
            };
        });
    }
    async read(options: { signal: AbortSignal }): Promise<Uint8Array | null> {
        const { signal } = options;
        this.check(signal);
        const result = await this.transaction("readonly", signal, null, null);
        this.check(signal);
        return result as Uint8Array | null;
    }
    async compareAndSet(
        expected: Uint8Array | null,
        encrypted: Uint8Array,
        options: { signal: AbortSignal },
    ): Promise<boolean> {
        const { signal } = options;
        this.check(signal);
        const previous = expected === null ? null : bytes(expected),
            next = bytes(encrypted);
        try {
            const result = await this.transaction(
                "readwrite",
                signal,
                previous,
                next,
            );
            this.check(signal);
            return result === true;
        } finally {
            previous?.fill(0);
            next.fill(0);
        }
    }
    private transaction(
        mode: IDBTransactionMode,
        signal: AbortSignal,
        expected: Uint8Array | null,
        next: Uint8Array | null,
    ): Promise<Uint8Array | null | boolean> {
        return new Promise((resolve, reject) => {
            this.check(signal);
            if (!this.db) throw bad();
            const tx = this.db.transaction(STORE, mode, {
                    durability: "strict",
                }),
                store = tx.objectStore(STORE);
            let result: Uint8Array | null | boolean = null,
                failed = false;
            const abort = () => {
                    failed = true;
                    try {
                        tx.abort();
                    } catch {
                        /* uncertain applied record preserved */
                    }
                },
                finish = () => signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abort, { once: true });
            tx.onabort = tx.onerror = () => {
                finish();
                if (result instanceof Uint8Array) result.fill(0);
                reject(bad());
            };
            tx.oncomplete = () => {
                finish();
                try {
                    this.check(signal);
                    if (failed) throw bad();
                    resolve(result);
                } catch {
                    if (result instanceof Uint8Array) result.fill(0);
                    reject(bad());
                }
            };
            const request = store.get(KEY);
            request.onsuccess = () => {
                let old: Uint8Array | null = null;
                try {
                    this.check(signal);
                    old =
                        request.result === undefined
                            ? null
                            : bytes(request.result);
                    if (mode === "readonly") {
                        result = old;
                        old = null;
                    } else {
                        result = same(old, expected);
                        if (result === true && next !== null) {
                            if (expected === null)
                                store.add(new Uint8Array(next), KEY);
                            else store.put(new Uint8Array(next), KEY);
                        }
                    }
                } catch {
                    abort();
                } finally {
                    old?.fill(0);
                }
            };
        });
    }
    close(): void {
        if (!this.closed) {
            this.closed = true;
            this.db?.close();
            this.db = null;
        }
    }
}
