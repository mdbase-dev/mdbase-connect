import type { CborValue } from "../cbor.js";
import type { RecordRef, Write } from "../client.js";
import type { PlainValue } from "../values.js";
import type { Problem, Receipt, RecordView, Uuid } from "../wire.js";

export type RecordSessionState =
    | "saved"
    | "unsaved"
    | "saving"
    | "conflict"
    | "recovery"
    | "error"
    | "deleted";
export interface RecordRecoveryRef {
    readonly mutationId: Uuid;
    readonly recordId: Uuid;
    /** Absent on native operations that did not capture a whole-source CAS. */
    readonly baseRevision: string | null;
}
export interface RecordRecovery extends RecordRecoveryRef {
    readonly receipt: Receipt | null;
    /** The genuine SDK Write, or null if submission failed before a response. */
    readonly write: Write | null;
}
export interface RecordSessionSnapshot {
    readonly state: RecordSessionState;
    readonly body: string;
    readonly frontmatter: ReadonlyMap<string, CborValue>;
    readonly record: RecordView;
    readonly remote: RecordView | null;
    readonly dirty: boolean;
    readonly problem: Problem | null;
    readonly recovery: RecordRecovery | null;
    /** Actual last original receipt, including settled rejection/conflict. */
    readonly lastReceipt: Receipt | null;
}
export type RecordResolution =
    | { readonly keep: "mine" | "theirs" }
    | { readonly body: string };
export interface RecordFlushOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}
export type RecordFlushResult =
    | { readonly ok: true; readonly record: RecordView }
    | { readonly ok: false; readonly problem: Problem };
export interface RecordSession {
    getSnapshot(): RecordSessionSnapshot;
    subscribe(listener: () => void): () => void;
    setBody(body: string): void;
    patchFrontmatter(
        patch:
            | Map<string, PlainValue>
            | { [key: string]: PlainValue | undefined },
    ): void;
    /** Explicitly rebase a known settled CAS conflict. Native holds stay protected. */
    resolve(choice: RecordResolution): void;
    flush(options?: RecordFlushOptions): Promise<RecordFlushResult>;
}
export interface RecordLease {
    readonly session: RecordSession;
    release(): void;
}
export interface RecordOpenOptions {
    autosave?: { idleMs: number } | false;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Caller-retained identity for a settled mutation whose readback failed.
     * Pending operations can also be recovered from the native pending API. */
    recovery?: RecordRecoveryRef;
}
export interface Records {
    open(ref: RecordRef, options?: RecordOpenOptions): Promise<RecordLease>;
}
