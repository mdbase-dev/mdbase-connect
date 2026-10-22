import type { ChangesWatch, MdbaseClient, RecordRef } from "./client.js";
import { mdbaseError } from "./errors.js";
import { uuid, hash } from "./codec.js";
import { RecordSessionImpl } from "./records/session.js";
import {
    complete,
    include,
    MAX_BYTES,
    problem,
    timeout,
} from "./records/witness.js";
import type {
    RecordLease,
    RecordOpenOptions,
    Records,
    RecordSession,
} from "./records/types.js";
export type {
    RecordLease,
    RecordOpenOptions,
    RecordSession,
    RecordSessionSnapshot,
    RecordSessionState,
    RecordRecovery,
    RecordRecoveryRef,
    RecordResolution,
    RecordFlushOptions,
    RecordFlushResult,
    Records,
} from "./records/types.js";
type Slot = {
    session: RecordSessionImpl;
    leases: number;
    bytes: number;
    policy: string;
};
/** One native record session per UUID/client. Last release suspends delivery and
 * autosave; dirty/recovering data stays owned here until explicitly settled.
 * Retained sessions are bounded, never evicted to make another open succeed. */
export class RecordsApi implements Records {
    private slots = new Map<string, Slot>();
    private bytes = 0;
    private closed = false;
    private opening: Promise<void> = Promise.resolve();
    private watch: ChangesWatch | null = null;
    private offWatch: (() => void) | null = null;
    private offStatus: (() => void) | null = null;
    constructor(private readonly client: MdbaseClient) {}
    open(
        ref: RecordRef,
        options: RecordOpenOptions = {},
    ): Promise<RecordLease> {
        const captured = {
            ...options,
            autosave: options.autosave
                ? { ...options.autosave }
                : options.autosave,
            ...(options.recovery ? { recovery: { ...options.recovery } } : {}),
        };
        if (captured.recovery) {
            captured.recovery = {
                ...captured.recovery,
                mutationId: uuid.dec(uuid.enc(captured.recovery.mutationId)),
                recordId: uuid.dec(uuid.enc(captured.recovery.recordId)),
            };
            if (captured.recovery.baseRevision !== null)
                hash.enc(captured.recovery.baseRevision);
        }
        timeout(captured.timeoutMs);
        if (
            captured.autosave &&
            (!Number.isSafeInteger(captured.autosave.idleMs) ||
                captured.autosave.idleMs < 1 ||
                captured.autosave.idleMs > 120_000)
        ) {
            throw mdbaseError(
                "invalid_request",
                "record autosave idleMs must be 1..120000",
                "invalid_autosave",
            );
        }
        // Serialize acquisition, not callers' signals or the record write intents.
        const selected: RecordRef =
            typeof ref === "string"
                ? ref
                : "id" in ref
                  ? ref.id
                  : { path: ref.path };
        const acquire = this.opening
            .catch(() => {})
            .then(() => this.acquire(selected, captured));
        this.opening = acquire.then(
            () => {},
            () => {},
        );
        return acquire;
    }
    private async acquire(
        ref: RecordRef,
        options: RecordOpenOptions,
    ): Promise<RecordLease> {
        if (this.closed)
            throw mdbaseError("unavailable", "record sessions client closed");
        options.signal?.throwIfAborted();
        const current = await this.client.get(ref, include, options.signal);
        options.signal?.throwIfAborted();
        if (this.closed)
            throw mdbaseError("unavailable", "record sessions client closed");
        complete(current);
        // Generic get may use a path; UUID selection must not be rebound.
        const id =
            typeof ref === "string" ? ref : "id" in ref ? ref.id : undefined;
        const expected = id === undefined ? undefined : uuid.dec(uuid.enc(id));
        if (expected !== undefined && expected !== current.id)
            throw mdbaseError(
                "invalid_request",
                "record open readback changed the requested UUID",
                "record_identity_mismatch",
            );
        const policy = JSON.stringify([
            options.autosave ? options.autosave.idleMs : false,
            options.timeoutMs ?? 30_000,
        ]);
        let slot = this.slots.get(current.id);
        if (slot && slot.leases > 0 && slot.policy !== policy)
            throw mdbaseError(
                "invalid_request",
                "active record leases must use the same autosave policy",
                "record_lease_policy",
            );
        if (!slot) {
            if (this.slots.size >= 64)
                throw mdbaseError(
                    "invalid_request",
                    "retained record sessions exceed 64; settle drafts before opening more",
                    "record_session_budget",
                );
            slot = {
                session: null as unknown as RecordSessionImpl,
                leases: 0,
                bytes: 0,
                policy,
            };
            const owned = slot;
            try {
                slot.session = new RecordSessionImpl(
                    this.client,
                    current,
                    (bytes) => {
                        const total = this.bytes - owned.bytes + bytes;
                        if (total > MAX_BYTES)
                            throw mdbaseError(
                                "invalid_request",
                                "record session retained data exceeds 8MiB",
                                "record_session_budget",
                            );
                        this.bytes = total;
                        owned.bytes = bytes;
                    },
                );
                await slot.session.restore(options.signal, options.recovery);
                options.signal?.throwIfAborted();
            } catch (error) {
                this.bytes -= owned.bytes;
                throw error;
            }
            this.slots.set(current.id, slot);
        } else {
            await slot.session.restore(options.signal, options.recovery);
            options.signal?.throwIfAborted();
        }
        slot.leases++;
        slot.policy = policy;
        slot.session.resume(options);
        this.startWatch();
        const owned = slot;
        let released = false;
        const offs = new Set<() => void>();
        const ensure = () => {
            if (released)
                throw mdbaseError("cancelled", "record lease released");
        };
        const session: RecordSession = Object.freeze({
            getSnapshot: owned.session.getSnapshot,
            subscribe: (listener: () => void) => {
                ensure();
                const off = owned.session.subscribe(listener);
                offs.add(off);
                return () => {
                    offs.delete(off);
                    off();
                };
            },
            setBody: (body: string) => {
                ensure();
                owned.session.setBody(body);
            },
            patchFrontmatter: (
                patch: Parameters<RecordSession["patchFrontmatter"]>[0],
            ) => {
                ensure();
                owned.session.patchFrontmatter(patch);
            },
            resolve: (choice: Parameters<RecordSession["resolve"]>[0]) => {
                ensure();
                owned.session.resolve(choice);
            },
            flush: (opts: Parameters<RecordSession["flush"]>[0]) => {
                ensure();
                return owned.session.flush(opts);
            },
        });
        const release = () => {
            if (released) return;
            released = true;
            options.signal?.removeEventListener("abort", release);
            for (const off of offs) off();
            offs.clear();
            if (--owned.leases === 0) {
                owned.session.suspend();
                if (!owned.session.retained) {
                    this.bytes -= owned.bytes;
                    this.slots.delete(current.id);
                }
            }
            if (![...this.slots.values()].some((s) => s.leases > 0))
                this.stopWatch();
        };
        options.signal?.addEventListener("abort", release, { once: true });
        if (options.signal?.aborted) {
            release();
            options.signal.throwIfAborted();
        }
        // Same-UUID hydration catches changes between initial get and watch startup.
        void owned.session.refresh();
        return Object.freeze({ session, release });
    }
    private startWatch(): void {
        if (this.watch) return;
        const watch = this.client.watchChanges(undefined, (batch) => {
            for (const [id, slot] of this.slots)
                if (
                    slot.leases > 0 &&
                    (batch.reset ||
                        batch.changes.some((change) => change.id === id))
                )
                    void slot.session.refresh();
        });
        this.watch = watch;
        // An own write's confirmation is not announced as a change again, so a
        // settled pending write refreshes the sessions from the status push.
        let pending = -1;
        this.offStatus = this.client.onStatus((s) => {
            const settled = s.pending < pending;
            pending = s.pending;
            if (settled && this.watch === watch)
                for (const slot of this.slots.values())
                    if (slot.leases > 0) void slot.session.refresh();
        });
        this.offWatch = watch.subscribe((state, error) => {
            if (this.watch !== watch) return;
            if (state === "active") {
                for (const slot of this.slots.values())
                    if (slot.leases > 0) void slot.session.refresh();
            } else if (error) {
                for (const slot of this.slots.values())
                    if (slot.leases > 0)
                        slot.session.observerProblem(error.toProblem());
            }
        });
        watch.ready.catch((error) => {
            if (this.watch === watch)
                for (const slot of this.slots.values())
                    if (slot.leases > 0)
                        slot.session.observerProblem(problem(error));
        });
    }
    private stopWatch(): void {
        this.offWatch?.();
        this.offWatch = null;
        this.offStatus?.();
        this.offStatus = null;
        const watch = this.watch;
        this.watch = null;
        watch?.();
    }
    /** Client close aborts delivery, never submits a replacement or discards drafts. */
    dispose(): void {
        this.closed = true;
        this.stopWatch();
        for (const slot of this.slots.values()) slot.session.suspend();
    }
}
