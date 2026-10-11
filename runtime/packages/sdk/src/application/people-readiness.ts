import { collectionPeopleDto } from "../app-host/collection-people.js";
import type { AppReplicaScope } from "../app-host/owner.js";
import { mdbaseError } from "../errors.js";
import type { AccountProfile, MdbasePeopleClient } from "../people.js";
import type {
    MdbaseApplicationFacetSnapshot,
    MdbaseApplicationRequestOptions,
} from "./entry.js";

export interface ApplicationPeopleReadinessOptions {
    readonly people: MdbasePeopleClient;
    readonly scope: Readonly<AppReplicaScope>;
    readonly generation: string;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
}
export interface ApplicationPeopleReadiness {
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
const snapshot = (
    code: string | null,
    checking = false,
): MdbaseApplicationFacetSnapshot =>
    Object.freeze({
        checking,
        assessment: null,
        problem: code === null ? null : Object.freeze({ code }),
    });
const fenced = snapshot("people_fenced");
const ready: MdbaseApplicationFacetSnapshot = Object.freeze({
    checking: false,
    assessment: Object.freeze({ status: "ready", problem: null }),
    problem: null,
});
const cancelled = () =>
    mdbaseError(
        "cancelled",
        "People readiness ended",
        "people_readiness_fenced",
    );
function profile(row: AccountProfile) {
    return {
        issuer: row.issuer,
        subject: row.subject,
        name: row.name,
        ...(row.accountId === undefined ? {} : { account_id: row.accountId }),
    };
}

/** Mandatory launch account/member metadata facet. Sequential READs on the SAME
 * public People client, not directory()/native Person or author inference.
 * Reuse the bounded metadata DTO validator; never retain names/IDs in snapshots.
 * Caller cancellation fences delivery while the original assessment/READ remains
 * occupied. Close releases only owned listeners, never the borrowed authority. */
export function createApplicationPeopleReadiness(
    input: ApplicationPeopleReadinessOptions,
): Readonly<ApplicationPeopleReadiness> {
    const scope = input.scope,
        account = scope.account,
        installation = scope.installation,
        collection = scope.collection;
    const generation = input.generation,
        lifetime = input.signal,
        people = input.people;
    const isCurrent = input.isCurrent.bind(input);
    const readCurrent =
        typeof people?.current === "function"
            ? people.current.bind(people)
            : undefined;
    const readMembers =
        typeof people?.members === "function"
            ? people.members.bind(people)
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
                input.scope === scope &&
                input.generation === generation &&
                input.signal === lifetime &&
                input.people === people &&
                !!generation &&
                generation.length <= 256 &&
                [account, installation, collection].every(
                    (id) => typeof id === "string" && !!id && id.length <= 128,
                ) &&
                scope.account === account &&
                scope.installation === installation &&
                scope.collection === collection
            );
        } catch {
            return false;
        }
    }
    function publish(next: MdbaseApplicationFacetSnapshot): void {
        value = current() ? next : fenced;
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                /* content-free */
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
        listeners.clear(); // pending remains occupied until its original READ settles
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
            const abort = () => finish(undefined, cancelled()),
                ended = () => {
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
                    "People readiness READ is occupied",
                    "people_readiness_busy",
                ),
            );
        const work = Promise.resolve().then(async () => {
            if (!current()) return fenced;
            if (!readCurrent || !readMembers)
                return snapshot("people_unsupported");
            try {
                const identity = await readCurrent({ signal: lifetime });
                if (!current()) return fenced;
                collectionPeopleDto("identity", {
                    ...profile(identity),
                    ...(identity.personSettingsUrl === undefined
                        ? {}
                        : { person_settings_url: identity.personSettingsUrl }),
                });
                if (!current()) return fenced;
                const members = await readMembers({ signal: lifetime });
                if (!current()) return fenced;
                if (!Array.isArray(members) || members.length > 1000)
                    return snapshot("people_response");
                collectionPeopleDto("members", {
                    members: Array.from(members, (row) => ({
                        ...profile(row),
                        role: row.role,
                    })),
                });
                if (!current()) return fenced;
                return ready;
            } catch {
                return snapshot(
                    current() ? "people_unavailable" : "people_fenced",
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
                    publish(snapshot("people_unavailable"));
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
