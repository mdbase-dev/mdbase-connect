import type { ApplicationNotifications } from "@mdbase-dev/connect-protocol";
import type { AppReplicaScope } from "../app-host/owner.js";
import { mdbaseError } from "../errors.js";
import type { TimersApi } from "../timers.js";
import { declaredTimerCriteria } from "./timer-criteria.js";
import type {
    MdbaseApplicationFacetSnapshot,
    MdbaseApplicationRequestOptions,
} from "./entry.js";

/** Factory projection from the canonical validated declaration. Explicit null
 * means no notification requirement; a missing projection never means empty.
 * Namespace is supplied from that declaration, never inferred from a scope. */
export interface ApplicationNotificationReadinessDeclaration {
    readonly declaration: Readonly<ApplicationNotifications> | null;
    readonly timerNamespace?: string;
}
export interface ApplicationNotificationReadinessOptions {
    readonly notifications?: ApplicationNotificationReadinessDeclaration;
    readonly timers?: Pick<TimersApi, "list">;
    readonly scope: Readonly<AppReplicaScope>;
    readonly generation: string;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
}
export interface ApplicationNotificationReadiness {
    getSnapshot(): MdbaseApplicationFacetSnapshot;
    subscribe(listener: () => void): () => void;
    start(
        options?: MdbaseApplicationRequestOptions,
    ): Promise<MdbaseApplicationFacetSnapshot>;
    refresh(
        options?: MdbaseApplicationRequestOptions,
    ): Promise<MdbaseApplicationFacetSnapshot>;
    close(): void;
}
const problem = (code: string) => Object.freeze({ code });
const snapshot = (
    code: string | null,
    checking = false,
): MdbaseApplicationFacetSnapshot =>
    Object.freeze({
        checking,
        assessment: null,
        problem: code === null ? null : problem(code),
    });
const fenced = snapshot("notifications_fenced");
const cancelled = () =>
    mdbaseError(
        "cancelled",
        "Notification readiness ended",
        "notification_readiness_fenced",
    );

/** Read-only facet, not aggregate application READY or delivery authorization.
 * Main can READ timer namespace access, but not notification criteria activation
 * or delivery/channel state. A successful list therefore cannot establish
 * declared-notification readiness. No registration, reconciliation or consent IO.
 * Caller cancellation fences delivery, not the occupied original READ slot.
 * Close releases only owned listeners, never the borrowed timers/authority. */
export function createApplicationNotificationReadiness(
    input: ApplicationNotificationReadinessOptions,
): Readonly<ApplicationNotificationReadiness> {
    const scope = input.scope;
    const account = scope.account,
        installation = scope.installation,
        collection = scope.collection;
    const generation = input.generation,
        lifetime = input.signal;
    const isCurrent = input.isCurrent.bind(input);
    const notifications = input.notifications,
        declaration = notifications?.declaration;
    const namespace = notifications?.timerNamespace,
        timers = input.timers;
    const read =
        typeof timers?.list === "function"
            ? timers.list.bind(timers)
            : undefined;
    const listeners = new Set<() => void>();
    let value = snapshot(null),
        closed = false,
        started = false;
    let pending: Promise<MdbaseApplicationFacetSnapshot> | null = null;
    function current(): boolean {
        try {
            if (closed || lifetime.aborted || isCurrent() !== true)
                return false;
            return (
                !closed &&
                !lifetime.aborted &&
                input.signal === lifetime &&
                input.scope === scope &&
                input.generation === generation &&
                !!generation &&
                generation.length <= 256 &&
                [account, installation, collection].every(
                    (id) => typeof id === "string" && !!id && id.length <= 128,
                ) &&
                scope.account === account &&
                scope.installation === installation &&
                scope.collection === collection &&
                input.notifications === notifications &&
                notifications?.declaration === declaration &&
                notifications?.timerNamespace === namespace &&
                input.timers === timers
            );
        } catch {
            return false;
        }
    }
    function publish(next: MdbaseApplicationFacetSnapshot): void {
        // A listener may synchronously close/fence the helper. Later listeners and
        // public delivery must see the fenced cut, never a resurrected assessment.
        value = current() ? next : fenced;
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                /* no caller diagnostics */
            }
        }
        if (!current()) value = fenced;
    }
    function getSnapshot(): MdbaseApplicationFacetSnapshot {
        if (!current()) value = fenced;
        return value;
    }
    function close(): void {
        if (closed) return;
        closed = true;
        lifetime.removeEventListener("abort", close);
        value = fenced;
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                /* owned listeners only */
            }
        }
        listeners.clear();
        // Do not release pending before its original reply or close the borrowed
        // timer service. Public settlement is not physical native/SQL drain proof.
    }
    lifetime.addEventListener("abort", close, { once: true });
    if (lifetime.aborted) close();

    function deliver(
        work: Promise<MdbaseApplicationFacetSnapshot>,
        signal?: AbortSignal,
    ): Promise<MdbaseApplicationFacetSnapshot> {
        if (!current() || signal?.aborted) return Promise.reject(cancelled());
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (
                result?: MdbaseApplicationFacetSnapshot,
                error?: unknown,
            ) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", abort);
                lifetime.removeEventListener("abort", abort);
                listeners.delete(ended);
                if (error !== undefined) reject(error);
                else resolve(result!);
            };
            const abort = () => finish(undefined, cancelled());
            const ended = () => {
                if (!current()) abort();
            };
            listeners.add(ended);
            signal?.addEventListener("abort", abort, { once: true });
            lifetime.addEventListener("abort", abort, { once: true });
            work.then(
                () => {
                    if (!current() || signal?.aborted) abort();
                    else finish(getSnapshot());
                },
                () => finish(undefined, cancelled()),
            );
            if (!current() || signal?.aborted) abort();
        });
    }
    function refresh(
        options: MdbaseApplicationRequestOptions = {},
    ): Promise<MdbaseApplicationFacetSnapshot> {
        const signal = options.signal;
        if (!current() || signal?.aborted) return Promise.reject(cancelled());
        if (pending)
            return Promise.reject(
                mdbaseError(
                    "unavailable",
                    "Notification readiness READ is occupied",
                    "notification_readiness_busy",
                ),
            );
        // Install the slot before dispatch, including synchronous source callbacks.
        const work = Promise.resolve().then(async () => {
            if (!current()) return snapshot("notifications_fenced");
            if (
                declaration === null &&
                notifications &&
                Object.hasOwn(notifications, "declaration")
            ) {
                return Object.freeze({
                    checking: false,
                    assessment: Object.freeze({
                        status: "ready" as const,
                        problem: null,
                    }),
                    problem: null,
                });
            }
            // Timers reach the connection only after the user approves them
            // for this collection. Say so, so the app can ask again.
            if (!read && declaredTimerCriteria(declaration).length) {
                return snapshot("notifications_consent_required");
            }
            if (
                !declaration ||
                typeof declaration !== "object" ||
                !read ||
                typeof namespace !== "string" ||
                !/^[A-Za-z0-9._-]{1,64}$/.test(namespace)
            ) {
                return snapshot("notifications_unsupported");
            }
            try {
                const result = await read(namespace, { signal: lifetime });
                if (!current()) return snapshot("notifications_fenced");
                if (
                    !result ||
                    result.namespace !== namespace ||
                    !Array.isArray(result.timers) ||
                    result.timers.length > 10000
                ) {
                    return snapshot("notifications_response");
                }
                // Accessible timer namespace is the narrow positive evidence. There is
                // still no READ of required notification criteria/delivery on main.
                return snapshot("notifications_unsupported");
            } catch {
                return snapshot(
                    current()
                        ? "notifications_unavailable"
                        : "notifications_fenced",
                );
            }
        });
        pending = work;
        publish(snapshot(null, true));
        const settled = work
            .then(
                (result) => {
                    publish(result);
                    return getSnapshot();
                },
                () => {
                    publish(snapshot("notifications_unavailable"));
                    return getSnapshot();
                },
            )
            .finally(() => {
                if (pending === work) pending = null;
            });
        return deliver(settled, signal);
    }
    return Object.freeze({
        getSnapshot,
        subscribe(listener: () => void) {
            if (closed) return () => {};
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        start(options: MdbaseApplicationRequestOptions = {}) {
            if (started)
                return deliver(
                    pending ?? Promise.resolve(getSnapshot()),
                    options.signal,
                );
            if (!current() || options.signal?.aborted)
                return Promise.reject(cancelled());
            started = true;
            return refresh(options);
        },
        refresh,
        close,
    });
}
