import { afterEach, describe, expect, it, vi } from "vitest";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import {
    AppWebCloudCopyBootstrapPersistence,
    type AppCloudCopyOutcomeScope,
    type AppCloudCopyOutcomeStore,
} from "../src/app-host/cloud-copy-persistence.js";
import type {
    AppCloudCopyBootstrapMetadata,
    AppCloudCopyOperation,
} from "../src/app-host/cloud-copy-bootstrap.js";
afterEach(() => vi.restoreAllMocks());
async function fixture(displayName?: string) {
    const source: AppCloudCopyOutcomeScope = {
        accountId: "11111111-1111-1111-1111-111111111111",
        connectorId: "66666666-6666-6666-6666-666666666666",
        deviceId: "44444444-4444-4444-4444-444444444444",
        installationId: "88888888-8888-8888-8888-888888888888",
        collection: "22222222-2222-2222-2222-222222222222",
        purpose: "create",
        ...(displayName === undefined ? {} : {displayName}),
        assetSha256: "aa".repeat(32),
        cpOrigin: "https://cp.example.test",
        logOrigin: "https://log.example.test",
        isCurrent: () => true,
        installationOwned: () => true,
    };
    const receipt = {
            connectorId: source.connectorId,
            deviceId: source.deviceId,
            installationId: source.installationId,
            signPublicKey: new Uint8Array(32).fill(1),
            kemPublicKey: new Uint8Array(32).fill(2),
            noisePublicKey: new Uint8Array(32).fill(3),
        },
        operation: AppCloudCopyOperation = {
            accountId: source.accountId,
            collection: source.collection,
            purpose: source.purpose,
            ...(displayName === undefined ? {} : {displayName}),
            assetSha256: source.assetSha256,
            cpOrigin: source.cpOrigin,
            logOrigin: source.logOrigin,
            ...receipt,
        },
        key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        ),
        controller = new AbortController(),
        signal = controller.signal;
    const state = {
            cipher: null as Uint8Array | null,
            borrowed: null as Uint8Array | null,
            lost: false,
            conflict: false,
        },
        store: AppCloudCopyOutcomeStore = {
            read: vi.fn(async () =>
                state.cipher === null ? null : new Uint8Array(state.cipher),
            ),
            compareAndSet: vi.fn(async (old, next) => {
                state.borrowed = next;
                if (state.conflict) return false;
                const actual = state.cipher;
                if (
                    actual === null
                        ? old !== null
                        : old === null ||
                          actual.length !== old.length ||
                          actual.some((v, i) => v !== old[i])
                )
                    return false;
                state.cipher = new Uint8Array(next);
                if (state.lost) throw Error("unknown committed write");
                return true;
            }),
        };
    const instance = (
        mode: "fresh" | "existing" = "fresh",
        scope = source,
        k = key,
    ) =>
        new AppWebCloudCopyBootstrapPersistence(scope, receipt, k, store, {
            mode,
            signal,
        });
    const item = Uint8Array.of(1, 2, 3),
        domain = new TextEncoder().encode("mdbase/v1/chain"),
        input = new Uint8Array(1 + domain.length + item.length);
    input[0] = domain.length;
    input.set(domain, 1);
    input.set(item, 1 + domain.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input)),
        metadata: AppCloudCopyBootstrapMetadata = {
            operation,
            genesisItem: item,
            expectedGenesis: `sha256:${Array.from(digest, (v) => v.toString(16).padStart(2, "0")).join("")}`,
        };
    return {
        source,
        receipt,
        operation,
        key,
        controller,
        signal,
        state,
        store,
        instance,
        metadata,
    };
}
describe("protected cloud-copy PUBLIC outcomes (actual WebCrypto, memory IO stand-in)", () => {
    it("preserves exact explicit name intent across pending/completed restore and refuses changing or omitting it", async () => {
        const f = await fixture("New collection");
        await f.instance().pending(f.operation, {signal: f.signal});
        const original = new Uint8Array(f.state.cipher!);
        expect(await f.instance("existing").restore({signal: f.signal})).toEqual({state: "pending", operation: f.operation});
        for (const name of [undefined, "Other"]) {
            const foreign = {...f.source, displayName: name};
            await expect(f.instance("existing", foreign).restore({signal: f.signal})).rejects.toThrow();
            await expect(f.instance("existing", foreign).pending({...f.operation, displayName: name}, {signal: f.signal})).rejects.toThrow();
        }
        expect(f.state.cipher).toEqual(original); expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
        await f.instance("existing").completed(f.metadata, {signal: f.signal});
        expect(await f.instance("existing").restore({signal: f.signal})).toEqual({state: "completed", metadata: f.metadata});
    });
    it("reads legacy v1 omitted-name outcomes without rewriting or treating them as an explicit default", async () => {
        const f = await fixture(); await f.instance().pending(f.operation, {signal: f.signal});
        const aad = encode(["mdbase/v1/app-cloud-copy-outcome-platform", ...[f.source.accountId, f.source.connectorId, f.source.deviceId, f.source.installationId, f.source.collection].map(uuidToBytes), f.source.purpose, f.source.cpOrigin, f.source.logOrigin, f.source.assetSha256, f.receipt.signPublicKey, f.receipt.kemPublicKey, f.receipt.noisePublicKey]);
        const outer = decode(f.state.cipher!) as Map<number, CborValue>;
        const iv = new Uint8Array(outer.get(1) as Uint8Array);
        const plain = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv, additionalData: new Uint8Array(aad)}, f.key, new Uint8Array(outer.get(2) as Uint8Array)));
        const record = decode(plain) as Map<number, CborValue>; record.set(0, 1); record.delete(3);
        const body = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: new Uint8Array(aad)}, f.key, new Uint8Array(encode(record))));
        f.state.cipher = encode(new Map<number,CborValue>([[0, 1], [1, iv], [2, body]])); plain.fill(0);
        const legacy = new Uint8Array(f.state.cipher);
        expect(await f.instance("existing").restore({signal: f.signal})).toEqual({state: "pending", operation: f.operation});
        await expect(f.instance("existing", {...f.source, displayName: "New collection"}).restore({signal: f.signal})).rejects.toThrow();
        expect(f.state.cipher).toEqual(legacy); expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
    });
    it("omitted name is distinct from an explicitly supplied default", async () => {
        const f = await fixture(); await f.instance().pending(f.operation, {signal: f.signal});
        await expect(f.instance("existing", {...f.source, displayName: "New collection"}).restore({signal: f.signal})).rejects.toThrow();
        expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
    });
    it("fresh pending/completion exact-cipher CAS and same original tuple restore, copied outputs/wiped write loans", async () => {
        const f = await fixture(),
            vault = f.instance();
        expect(await vault.restore({ signal: f.signal })).toEqual({
            state: "none",
        });
        await vault.pending(f.operation, { signal: f.signal });
        expect(f.state.borrowed!.every((v) => v === 0)).toBe(true);
        const pendingCipher = new Uint8Array(f.state.cipher!);
        expect(
            (await f.instance("existing").restore({ signal: f.signal })).state,
        ).toBe("pending");
        await vault.completed(f.metadata, { signal: f.signal });
        expect(f.state.borrowed!.every((v) => v === 0)).toBe(true);
        expect(f.state.cipher).not.toEqual(pendingCipher);
        const restored = await f
            .instance("existing")
            .restore({ signal: f.signal });
        expect(restored).toEqual({ state: "completed", metadata: f.metadata });
        if (restored.state === "completed")
            restored.metadata.genesisItem.fill(0);
        expect(
            await f.instance("existing").restore({ signal: f.signal }),
        ).toEqual({ state: "completed", metadata: f.metadata });
    });
    it("missing existing/corrupt/wrong KEK never becomes none or writes fresh", async () => {
        const f = await fixture();
        await expect(
            f.instance("existing").restore({ signal: f.signal }),
        ).rejects.toThrow("preserve storage");
        expect(f.store.compareAndSet).not.toHaveBeenCalled();
        await f.instance().pending(f.operation, { signal: f.signal });
        const original = new Uint8Array(f.state.cipher!),
            other = await crypto.subtle.generateKey(
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"],
            );
        await expect(
            f
                .instance("existing", f.source, other)
                .restore({ signal: f.signal }),
        ).rejects.toThrow();
        f.state.cipher![f.state.cipher!.length - 1] =
            f.state.cipher![f.state.cipher!.length - 1]! ^ 1;
        await expect(
            f.instance("existing").restore({ signal: f.signal }),
        ).rejects.toThrow();
        expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
        f.state.cipher = original;
        expect(
            (await f.instance("existing").restore({ signal: f.signal })).state,
        ).toBe("pending");
    });
    it.each([
        "accountId",
        "collection",
        "purpose",
        "assetSha256",
        "cpOrigin",
        "logOrigin",
    ] as const)(
        "foreign %s AAD refuses while preserving ciphertext",
        async (field) => {
            const f = await fixture();
            await f.instance().pending(f.operation, { signal: f.signal });
            const original = new Uint8Array(f.state.cipher!),
                foreign = {
                    ...f.source,
                    [field]:
                        field === "purpose"
                            ? "join"
                            : field === "assetSha256"
                              ? "bb".repeat(32)
                              : field.endsWith("Origin")
                                ? "https://foreign.test"
                                : "99999999-9999-9999-9999-999999999999",
                } as AppCloudCopyOutcomeScope;
            await expect(
                f.instance("existing", foreign).restore({ signal: f.signal }),
            ).rejects.toThrow();
            expect(f.state.cipher).toEqual(original);
        },
    );
    it("lost-applied pending/completion are preserved/restored, never blindly retried/downgraded", async () => {
        const f = await fixture(),
            vault = f.instance();
        f.state.lost = true;
        await expect(
            vault.pending(f.operation, { signal: f.signal }),
        ).rejects.toThrow();
        f.state.lost = false;
        const restored = f.instance("existing");
        expect((await restored.restore({ signal: f.signal })).state).toBe(
            "pending",
        );
        f.state.lost = true;
        await expect(
            restored.completed(f.metadata, { signal: f.signal }),
        ).rejects.toThrow();
        f.state.lost = false;
        expect(
            await f.instance("existing").restore({ signal: f.signal }),
        ).toEqual({ state: "completed", metadata: f.metadata });
        const cipher = new Uint8Array(f.state.cipher!);
        await restored.pending(f.operation, { signal: f.signal });
        await restored.completed(f.metadata, { signal: f.signal });
        expect(f.state.cipher).toEqual(cipher);
        expect(f.store.compareAndSet).toHaveBeenCalledTimes(2);
    });
    it("CAS conflict/completion without pending/bad genesis cannot overwrite", async () => {
        const f = await fixture(),
            vault = f.instance();
        await expect(
            vault.completed(f.metadata, { signal: f.signal }),
        ).rejects.toThrow();
        f.state.conflict = true;
        await expect(
            vault.pending(f.operation, { signal: f.signal }),
        ).rejects.toThrow();
        expect(f.state.cipher).toBeNull();
        f.state.conflict = false;
        await vault.pending(f.operation, { signal: f.signal });
        const cipher = new Uint8Array(f.state.cipher!);
        await expect(
            vault.completed(
                { ...f.metadata, expectedGenesis: `sha256:${"00".repeat(32)}` },
                { signal: f.signal },
            ),
        ).rejects.toThrow();
        await expect(
            vault.completed(
                {
                    ...f.metadata,
                    operation: {
                        ...f.operation,
                        noisePublicKey: new Uint8Array(32).fill(8),
                    },
                },
                { signal: f.signal },
            ),
        ).rejects.toThrow();
        expect(f.state.cipher).toEqual(cipher);
    });
    it.each(["current", "owned", "store", "scope", "signal"])(
        "after-read %s drift cannot issue a write",
        async (drift) => {
            const f = await fixture(),
                vault = f.instance(),
                read = f.store.read;
            f.store.read = read;
            const spy = read as ReturnType<typeof vi.fn>;
            spy.mockImplementation(async () => {
                if (drift === "current")
                    Object.assign(f.source, { isCurrent: () => true });
                if (drift === "owned")
                    Object.assign(f.source, { installationOwned: () => true });
                if (drift === "store") f.store.compareAndSet = async () => true;
                if (drift === "scope")
                    Object.assign(f.source, {
                        collection: "99999999-9999-9999-9999-999999999999",
                    });
                if (drift === "signal") f.controller.abort();
                return null;
            });
            await expect(
                vault.pending(f.operation, { signal: f.signal }),
            ).rejects.toThrow();
            expect(f.state.cipher).toBeNull();
        },
    );
    it("original options signal cannot be replaced after await; closed vault synchronously fences", async () => {
        const f = await fixture(),
            vault = f.instance(),
            options = { signal: f.signal },
            read = f.store.read as ReturnType<typeof vi.fn>;
        read.mockImplementation(async () => {
            options.signal = new AbortController().signal;
            f.controller.abort();
            return null;
        });
        await expect(vault.restore(options)).rejects.toThrow();
        const g = await fixture(),
            closed = g.instance();
        closed.close();
        await expect(
            closed.pending(g.operation, { signal: g.signal }),
        ).rejects.toThrow();
        expect(g.store.read).not.toHaveBeenCalled();
    });
});
