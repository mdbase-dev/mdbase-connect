import { decode, encode, type CborValue } from "../cbor.js";
import type { MdbaseClient, UpdateInput } from "../client.js";
import { MdbaseError, mdbaseError } from "../errors.js";
import { toValue, uuidv7, type PlainValue } from "../values.js";
import {
    receipt as receiptCodec,
    type FmMap,
    type Problem,
    type Receipt,
    type RecordView,
} from "../wire.js";
import {
    complete,
    confirmed,
    copy,
    include,
    problem,
    protectedRecord,
    recordBytes,
    refusal,
    textBytes,
    timeout,
} from "./witness.js";
import type {
    RecordFlushOptions,
    RecordFlushResult,
    RecordOpenOptions,
    RecordRecovery,
    RecordRecoveryRef,
    RecordResolution,
    RecordSessionSnapshot,
    RecordSessionState,
} from "./types.js";

/** When a flush must finish, and how much of it the receipt wait leaves for readback. */
type Budget = { until: number; margin: number };
type Captured = {
    bound: boolean;
    recovery: RecordRecovery;
    body: string;
    patch: Map<string, CborValue | undefined>;
};
export class RecordSessionImpl {
    private base: RecordView;
    private body: string;
    private patch = new Map<string, CborValue | undefined>();
    private remote: RecordView | null = null;
    private captured: Captured | null = null;
    private lastReceipt: Receipt | null = null;
    private state: RecordSessionState;
    private why: Problem | null = null;
    private snapshot!: RecordSessionSnapshot;
    private listeners = new Set<() => void>();
    private life = new AbortController();
    private running: Promise<RecordFlushResult> | null = null;
    /** Whether `running` may submit the draft, or only settles a captured write. */
    private writing = false;
    private refreshRunning: Promise<void> | null = null;
    private refreshAgain = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private active = false;
    private idle: number | false = false;
    private defaultTimeout = 30_000;
    constructor(
        private readonly client: MdbaseClient,
        record: RecordView,
        private readonly reserve: (bytes: number) => void,
    ) {
        complete(record);
        this.base = copy(record);
        this.body = record.body!;
        this.state = protectedRecord(record) ? "conflict" : resting(record);
        this.publish();
    }
    async restore(
        signal: AbortSignal | undefined,
        hint?: RecordRecoveryRef,
    ): Promise<void> {
        if (this.captured) {
            if (hint && hint.mutationId !== this.captured.recovery.mutationId)
                throw mdbaseError(
                    "invalid_request",
                    "record already owns another recovery identity",
                    "record_recovery_mismatch",
                );
            return;
        }
        if (hint) {
            if (hint.recordId !== this.id)
                throw mdbaseError(
                    "invalid_request",
                    "recovery belongs to another native record",
                    "record_identity_mismatch",
                );
            this.captured = {
                bound: false,
                body: this.body,
                patch: new Map(),
                recovery: { ...hint, receipt: null, write: null },
            };
        }
        // A pending write from an earlier session is kept on this device and
        // settled by the write ledger; the record stays editable.
        signal?.throwIfAborted();
        if (this.captured) {
            this.state = "recovery";
            this.why = refusal(
                "outcome_unknown",
                "recover the original native mutation before another edit",
                "record_recovery_required",
            ).toProblem();
            this.publish();
        }
    }
    get id(): string {
        return this.base.id;
    }
    get dirty(): boolean {
        return this.body !== this.base.body || this.patch.size > 0;
    }
    get retained(): boolean {
        return this.dirty || this.captured !== null || !confirmed(this.base);
    }
    getSnapshot = (): RecordSessionSnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    resume(options: RecordOpenOptions): void {
        if (!this.active) {
            this.life = new AbortController();
            this.active = true;
        }
        this.defaultTimeout = timeout(options.timeoutMs);
        this.idle = options.autosave ? options.autosave.idleMs : false;
        this.schedule();
    }
    suspend(): void {
        this.active = false;
        this.clearTimer();
        this.life.abort();
    }
    private ensure(): void {
        if (!this.active)
            throw mdbaseError("cancelled", "record lease has been released");
    }
    setBody = (body: string): void => {
        this.ensure();
        if (typeof body !== "string")
            throw mdbaseError("invalid_request", "record body must be text");
        this.charge(body, this.patch);
        this.body = body;
        this.edited();
    };
    patchFrontmatter = (
        patch:
            | Map<string, PlainValue>
            | { [key: string]: PlainValue | undefined },
    ): void => {
        this.ensure();
        const next = new Map(this.patch);
        for (const [key, input] of patch instanceof Map
            ? patch
            : Object.entries(patch)) {
            const value =
                input === undefined
                    ? undefined
                    : decode(encode(toValue(input)));
            const before = this.base.frontmatter.get(key);
            if (
                !this.captured?.patch.has(key) &&
                ((value === undefined && before === undefined) ||
                    (value !== undefined &&
                        before !== undefined &&
                        equal(value, before)))
            )
                next.delete(key);
            else next.set(key, value);
        }
        this.charge(this.body, next);
        this.patch = next;
        this.edited();
    };
    private edited(): void {
        if (
            !this.captured &&
            this.state !== "conflict" &&
            this.state !== "deleted"
        ) {
            this.state = this.dirty ? "unsaved" : resting(this.base);
            this.why = null;
        }
        this.publish();
        this.schedule();
    }
    private charge(
        body = this.body,
        patch = this.patch,
        base = this.base,
        remote = this.remote,
        receipt = this.lastReceipt,
        captured = this.captured,
    ): void {
        let bytes =
            recordBytes(base) +
            textBytes(body) +
            encode(new Map([...patch].map(([k, v]) => [k, v ?? null])))
                .byteLength *
                2;
        if (remote) bytes += recordBytes(remote);
        if (captured)
            bytes +=
                textBytes(captured.body) +
                encode(
                    new Map(
                        [...captured.patch].map(([k, v]) => [k, v ?? null]),
                    ),
                ).byteLength *
                    2;
        if (receipt) bytes += encode(receiptCodec.enc(receipt)).byteLength * 2;
        this.reserve(bytes);
    }
    private publish(): void {
        this.charge();
        const fm: FmMap = new Map(this.base.frontmatter);
        for (const [k, v] of this.patch) {
            if (v === undefined) fm.delete(k);
            else fm.set(k, v);
        }
        this.snapshot = Object.freeze({
            state: this.state,
            body: this.body,
            frontmatter: decode(encode(fm)) as FmMap,
            record: copy(this.base),
            remote: this.remote ? copy(this.remote) : null,
            dirty: this.dirty,
            problem: this.why,
            lastReceipt: this.lastReceipt
                ? receiptCodec.dec(
                      decode(encode(receiptCodec.enc(this.lastReceipt))),
                  )
                : null,
            recovery: this.captured
                ? Object.freeze({ ...this.captured.recovery })
                : null,
        });
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                /* Consumer callback does not own native recovery. */
            }
        }
    }
    private clearTimer(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }
    private schedule(): void {
        this.clearTimer();
        if (
            this.active &&
            this.idle !== false &&
            this.dirty &&
            this.state === "unsaved" &&
            !this.running
        ) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.flush().catch(() => {});
            }, this.idle);
        }
    }
    private async read(signal: AbortSignal): Promise<RecordView> {
        const record = await this.client.get(this.id, include, signal);
        signal.throwIfAborted();
        complete(record, this.id);
        return record;
    }
    /** Native change notifications are hints only; hydrate the same UUID. */
    refresh = (): Promise<void> => {
        if (!this.active) return Promise.resolve();
        if (this.refreshRunning) {
            this.refreshAgain = true;
            return this.refreshRunning;
        }
        const signal = this.life.signal;
        this.refreshRunning = (async () => {
            do {
                this.refreshAgain = false;
                try {
                    const current = await this.read(signal);
                    if (this.captured || this.running) {
                        // A captured write settles from its receipt, never from
                        // this hint; re-settle it here so a write that confirms
                        // after its flush gave up still ends saved.
                        if (this.captured && !this.running)
                            void this.start(false, {}).catch(() => {});
                        continue;
                    }
                    this.charge(this.body, this.patch, this.base, current);
                    if (!this.dirty) {
                        this.base = copy(current);
                        this.body = current.body!;
                        this.remote = null;
                        this.state = protectedRecord(current)
                            ? "conflict"
                            : resting(current);
                        this.why = null;
                    } else if (
                        current.revision !== this.base.revision ||
                        protectedRecord(current)
                    ) {
                        this.remote = copy(current);
                        this.state = "conflict";
                        this.why = refusal(
                            "conflict",
                            "record changed while this draft was open",
                            "record_session_conflict",
                        ).toProblem();
                    }
                    this.publish();
                } catch (error) {
                    if (signal.aborted) return;
                    this.why = problem(error);
                    this.state =
                        this.why.code === "not_found"
                            ? "deleted"
                            : this.captured
                              ? "recovery"
                              : "error";
                    this.publish();
                }
            } while (this.refreshAgain && !signal.aborted);
        })().finally(() => {
            this.refreshRunning = null;
        });
        return this.refreshRunning;
    };
    observerProblem(why: Problem): void {
        if (!this.active) return;
        this.why = why;
        this.state = this.captured ? "recovery" : "error";
        this.publish();
    }
    flush = (options: RecordFlushOptions = {}): Promise<RecordFlushResult> => {
        this.ensure();
        this.clearTimer();
        return this.start(true, options);
    };
    /**
     * Run a drive. `write` submits the draft; otherwise it only settles a
     * captured write. A flush arriving during a settle-only drive runs after it.
     */
    private start(
        write: boolean,
        options: RecordFlushOptions,
    ): Promise<RecordFlushResult> {
        const duration = timeout(options.timeoutMs ?? this.defaultTimeout);
        const limit = deadline(duration);
        const callerSignal = AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            limit.signal,
        ]);
        const prior = this.running;
        // A peer's validated deadline/cancellation bounds only its wait. The
        // original drive retains its original signal, MID, receipt and draft.
        if (prior && (this.writing || !write))
            return wait(prior, callerSignal).finally(limit.clear);
        const signal = AbortSignal.any([this.life.signal, callerSignal]);
        // The receipt wait ends before the flush deadline, so running out of
        // time while offline reads back as kept on this device, not cancelled.
        const budget: Budget = {
            until: Date.now() + duration,
            margin: Math.min(2_000, Math.floor(duration / 4)),
        };
        const drive = () => this.drive(signal, budget, write);
        const run: Promise<RecordFlushResult> = (
            prior ? prior.then(drive, drive) : drive()
        ).finally(() => {
            limit.clear();
            if (this.running !== run) return;
            this.running = null;
            this.writing = false;
            this.schedule();
        });
        this.running = run;
        this.writing = write;
        return run;
    }
    private async drive(
        signal: AbortSignal,
        budget: Budget,
        submit: boolean,
    ): Promise<RecordFlushResult> {
        try {
            for (;;) {
                signal.throwIfAborted();
                if (this.captured) {
                    await this.settle(signal, budget);
                    continue;
                }
                if (!submit)
                    return confirmed(this.base)
                        ? { ok: true, record: copy(this.base) }
                        : {
                              ok: true,
                              record: copy(this.base),
                              saved: "on_device",
                          };
                const current = await this.read(signal);
                if (protectedRecord(current)) {
                    this.charge(this.body, this.patch, this.base, current);
                    this.remote = copy(current);
                    throw refusal(
                        "conflict",
                        "native hold/unresolved edits require native resolution before saving",
                        "native_protection_resolution_required",
                    );
                }
                if (this.state === "deleted")
                    throw refusal(
                        "conflict",
                        "the original record was deleted",
                        "record_deleted",
                    );
                if (!this.dirty) {
                    this.charge(current.body!, this.patch, current, null);
                    this.base = copy(current);
                    this.body = current.body!;
                    this.remote = null;
                    this.state = resting(current);
                    this.why = null;
                    this.publish();
                    return confirmed(current)
                        ? { ok: true, record: copy(current) }
                        : { ok: true, record: copy(current), saved: "on_device" };
                }
                if (
                    current.revision !== this.base.revision ||
                    this.state === "conflict"
                ) {
                    this.charge(this.body, this.patch, this.base, current);
                    this.remote = copy(current);
                    throw refusal(
                        "conflict",
                        "explicitly resolve the current native revision before saving",
                        "record_session_conflict",
                    );
                }
                complete(this.base, this.id);
                this.base = copy(current); // Same SHA, now actual current native state, not inferred confirmation.
                const body = this.body,
                    patch = new Map(this.patch),
                    mutationId = uuidv7();
                const captured: Captured = {
                    bound: true,
                    body,
                    patch,
                    recovery: {
                        mutationId,
                        recordId: this.id,
                        baseRevision: this.base.revision,
                        receipt: null,
                        write: null,
                    },
                };
                this.charge(
                    this.body,
                    this.patch,
                    this.base,
                    this.remote,
                    this.lastReceipt,
                    captured,
                );
                this.captured = captured;
                this.state = "saving";
                this.why = null;
                this.publish();
                const changes: UpdateInput = { ifRevision: this.base.revision };
                if (body !== this.base.body) changes.body = body;
                const sets = new Map<string, PlainValue>(),
                    unset: string[] = [];
                for (const [key, value] of patch) {
                    if (value === undefined) unset.push(key);
                    else sets.set(key, value as PlainValue);
                }
                if (sets.size) changes.patch = sets;
                if (unset.length) changes.unset = unset;
                const write = await this.client.update(
                    copy(this.base),
                    changes,
                    { mutationId, include, conflictMode: "reject", signal },
                );
                signal.throwIfAborted();
                if (write.mutationId !== mutationId)
                    throw refusal(
                        "outcome_unknown",
                        "native write changed its original mutation identity",
                        "mutation_identity_mismatch",
                    );
                this.captured.recovery = {
                    ...this.captured.recovery,
                    write,
                    receipt: write.receipt,
                };
                this.publish();
            }
        } catch (error) {
            this.why = problem(error);
            this.state = this.captured
                ? "recovery"
                : this.why.code === "conflict"
                  ? "conflict"
                  : this.why.code === "not_found"
                    ? "deleted"
                    : this.why.code === "outcome_unknown"
                      ? "recovery"
                      : "error";
            this.publish();
            return { ok: false, problem: this.why };
        }
    }
    private async settle(signal: AbortSignal, budget: Budget): Promise<void> {
        const captured = this.captured!,
            original = captured.recovery;
        const receipt = await this.client.awaitReceipt(
            original.mutationId,
            Math.max(1, budget.until - Date.now() - budget.margin),
            signal,
        );
        signal.throwIfAborted();
        if (receipt.mutation !== original.mutationId)
            throw refusal(
                "outcome_unknown",
                "native receipt belongs to another mutation",
                "mutation_identity_mismatch",
            );
        const linked =
            receipt.records?.some(
                (record) => record.id === original.recordId,
            ) ?? false;
        if (
            (receipt.records?.length && !linked) ||
            (!captured.bound && receipt.state === "confirmed" && !linked)
        ) {
            throw refusal(
                "outcome_unknown",
                "receipt does not bind the original native record identity",
                "receipt_record_witness_required",
            );
        }
        if (linked) captured.bound = true;
        this.charge(this.body, this.patch, this.base, this.remote, receipt);
        this.lastReceipt = receipt;
        captured.recovery = { ...original, receipt };
        this.publish();
        if (receipt.state === "unknown")
            throw refusal(
                "outcome_unknown",
                "original native mutation is not settled; no resubmit",
                "record_receipt_pending",
            );
        if (receipt.state === "rejected" || receipt.status === "conflicted") {
            // The original outcome is now known. Retain its genuine lastReceipt;
            // no new intent is produced until explicit conflict resolution.
            this.captured = null;
            throw receipt.problem
                ? new MdbaseError(receipt.problem)
                : refusal(
                      "conflict",
                      "original mutation conflicted",
                      "record_session_conflict",
                  );
        }
        const current = await this.read(signal);
        // Still pending after the wait: the write is kept on this device and the
        // ledger settles it. Not a failure, and nothing is resubmitted.
        const kept = receipt.state === "pending";
        if (kept ? protectedRecord(current) : !confirmed(current))
            throw refusal(
                "outcome_unknown",
                "confirmed receipt has pending/protected current readback",
                "unqualified_readback",
            );
        this.charge(this.body, this.patch, current, null);
        const sameBody = this.body === captured.body;
        for (const [key, value] of captured.patch) {
            const latest = this.patch.get(key);
            if (
                this.patch.has(key) &&
                (value === undefined
                    ? latest === undefined
                    : latest !== undefined && equal(value, latest))
            )
                this.patch.delete(key);
        }
        this.base = copy(current);
        if (sameBody) this.body = current.body!;
        this.captured = null;
        this.remote = null;
        this.state = this.dirty ? "unsaved" : resting(current);
        this.why = null;
        this.publish();
    }
    resolve = (choice: RecordResolution): void => {
        this.ensure();
        if (this.captured || this.running)
            throw refusal(
                "outcome_unknown",
                "recover the original mutation before resolving or preparing another",
                "record_recovery_required",
            );
        const remote = this.remote;
        if (!remote || !confirmed(remote))
            throw refusal(
                "conflict",
                "a confirmed unprotected native record is required for resolution",
                "native_protection_resolution_required",
            );
        const body =
            "body" in choice
                ? choice.body
                : choice.keep === "theirs"
                  ? remote.body!
                  : this.body;
        const patch =
            "keep" in choice && choice.keep === "theirs"
                ? new Map<string, CborValue | undefined>()
                : this.patch;
        this.charge(body, patch, remote, null);
        this.base = copy(remote);
        this.body = body;
        this.patch = patch;
        this.remote = null;
        this.state = this.dirty ? "unsaved" : "saved";
        this.why = null;
        this.publish();
        this.schedule();
    };
}
/** A clean record's state: confirmed is saved, pending is saved on this device. */
function resting(record: RecordView): RecordSessionState {
    return confirmed(record) ? "saved" : "saved_on_device";
}
function equal(a: CborValue, b: CborValue): boolean {
    const x = encode(a),
        y = encode(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
}
/** A deadline signal on the page's timers, cleared once its drive ends. */
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(
        () =>
            controller.abort(
                new DOMException("record flush timed out", "TimeoutError"),
            ),
        ms,
    );
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const stop = () => {
            cleanup();
            reject(mdbaseError("cancelled", "record flush waiter cancelled"));
        };
        const cleanup = () => signal.removeEventListener("abort", stop);
        if (signal.aborted) {
            stop();
            return;
        }
        signal.addEventListener("abort", stop, { once: true });
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}
