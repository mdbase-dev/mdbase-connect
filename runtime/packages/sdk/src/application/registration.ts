import {
    APPLICATION_MANIFEST_MAX_BYTES,
    parseVersionedAppManifest,
} from "@mdbase-dev/connect-protocol/manifest";
import { selectAppEnvironment } from "../app-host/app-environment.js";
import { MdbaseError, mdbaseError } from "../errors.js";
import {
    applicationDeclaration,
    plainApplicationManifest,
    type MdbaseApplicationDeclaration,
} from "./declaration.js";
import { appReleaseTrust } from "./packaged-trust.js";

export interface ApplicationRegistrationOptions {
    readonly declaration: Readonly<MdbaseApplicationDeclaration>;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    readonly fetch?: typeof fetch;
}
export interface ApplicationRegistration {
    readonly id: string;
    readonly name: string;
    readonly manifestDigest: string;
}
const nativeId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nil = "00000000-0000-0000-0000-000000000000";
const transient = new Set([408, 429, 500, 502, 503, 504]);
const binding = () =>
    mdbaseError(
        "invalid_request",
        "Application registration binding mismatch",
        "application_registration_binding",
    );
const badReply = () =>
    mdbaseError(
        "unavailable",
        "Application registration evidence invalid",
        "application_registration_response",
    );
const unknown = () =>
    mdbaseError(
        "outcome_unknown",
        "Original application registration outcome unknown",
        "application_registration_unknown",
    );
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw badReply();
    return value as Record<string, unknown>;
}
/** Structural equality of canonical parser outputs, NOT a parser, compiler or
 * digest implementation. The original authenticated CP supplies the digest. */
function sameJson(left: unknown, right: unknown): boolean {
    const stack: [unknown, unknown][] = [[left, right]];
    let nodes = 0;
    while (stack.length) {
        if (++nodes > 524288) return false;
        const [a, b] = stack.pop()!;
        if (a === b) continue;
        if (
            !a ||
            !b ||
            typeof a !== "object" ||
            typeof b !== "object" ||
            Array.isArray(a) !== Array.isArray(b)
        )
            return false;
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) return false;
        for (const key of keys) {
            if (!Object.hasOwn(b, key)) return false;
            stack.push([
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
            ]);
        }
    }
    return true;
}

/** SDK-internal public metadata resolution, BEFORE Worker/DB/key allocation.
 * The sole retry exception is the exact immutable register upsert: CP uniqueness
 * preserves the same application row and reconciliation job for identical body
 * bytes. This does not authorize retrying enrollment/create/other unknown writes.
 * No app-supplied endpoint, trust, storage rebinding or registration cache. */
export async function resolveApplicationRegistration(
    input: ApplicationRegistrationOptions,
): Promise<Readonly<ApplicationRegistration>> {
    const original = input.declaration,
        signal = input.signal,
        guard = input.isCurrent,
        fetcher = input.fetch ?? globalThis.fetch;
    const sourceManifest = original.manifest;
    const declaration = applicationDeclaration(original);
    function check(): void {
        try {
            if (
                !signal.aborted &&
                input.signal === signal &&
                input.declaration === original &&
                input.isCurrent === guard &&
                original.id === declaration.id &&
                original.name === declaration.name &&
                original.origin === declaration.origin &&
                original.environment === declaration.environment &&
                original.manifest === sourceManifest &&
                guard.call(input) === true &&
                !signal.aborted
            )
                return;
        } catch {
            /* no caller diagnostic content */
        }
        throw mdbaseError(
            "cancelled",
            "Application registration fenced",
            "application_registration_fenced",
        );
    }
    check();
    let environment: ReturnType<typeof selectAppEnvironment>,
        manifest: ReturnType<typeof parseVersionedAppManifest>["manifest"];
    try {
        environment = selectAppEnvironment({
            environment: declaration.environment,
            appOrigin: declaration.origin,
            release: appReleaseTrust(),
        });
    } catch {
        check();
        throw mdbaseError(
            "unavailable",
            "SDK registration environment unavailable",
            "application_registration_unavailable",
        );
    }
    try {
        manifest = parseVersionedAppManifest(plainApplicationManifest(declaration), {
            allowLocal: declaration.environment === "lab",
        }).manifest;
    } catch {
        throw binding();
    }
    if (
        manifest.name !== declaration.name ||
        manifest.distribution === "portable" ||
        new URL(manifest.homepage).origin !== declaration.origin
    )
        throw binding();
    const body = JSON.stringify({ manifest }),
        url = `${environment.cpOrigin}/v1/apps/register`;
    if (
        new TextEncoder().encode(body).length >
            APPLICATION_MANIFEST_MAX_BYTES + 32 ||
        typeof fetcher !== "function"
    )
        throw binding();
    const control = new AbortController(),
        abort = () => control.abort(),
        timer = setTimeout(abort, 15000);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", abort, { once: true });
    function current(): void {
        check();
        if (control.signal.aborted) throw unknown();
    }
    async function decode(
        response: Response,
    ): Promise<Record<string, unknown>> {
        const buffer = new Uint8Array(
            2 * APPLICATION_MANIFEST_MAX_BYTES + 8192,
        );
        let count = 0;
        const length = response.headers.get("content-length");
        if (
            length !== null &&
            /^(0|[1-9][0-9]*)$/.test(length) &&
            Number(length) > buffer.length
        ) {
            void response.body?.cancel().catch(() => {});
            throw badReply();
        }
        if (!response.body) throw badReply();
        const reader = response.body.getReader();
        try {
            for (;;) {
                const part = await reader.read();
                try {
                    current();
                    if (part.done) break;
                    if (count + part.value.length > buffer.length)
                        throw badReply();
                    buffer.set(part.value, count);
                    count += part.value.length;
                } finally {
                    part.value?.fill(0);
                }
            }
            try {
                return record(
                    JSON.parse(
                        new TextDecoder("utf-8", { fatal: true }).decode(
                            buffer.subarray(0, count),
                        ),
                    ),
                );
            } catch {
                throw badReply();
            }
        } finally {
            buffer.fill(0);
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    function receipt(
        value: Record<string, unknown>,
    ): Readonly<ApplicationRegistration> {
        const app = record(value.application),
            id = app.id,
            digest = app.manifest_digest;
        if (typeof id !== "string" || !nativeId.test(id) || id === nil)
            throw badReply();
        if (nativeId.test(declaration.id) && id !== declaration.id)
            throw binding();
        if (
            typeof digest !== "string" ||
            !/^[0-9a-f]{64}$/.test(digest) ||
            app.name !== manifest.name ||
            app.canonical_identity !==
                `bundle:${manifest.id}:sha256:${digest}` ||
            app.family_identity !== `bundle:${manifest.id}` ||
            app.distribution !== "web"
        )
            throw badReply();
        if (!app.application_declaration)
            throw mdbaseError(
                "upgrade_required",
                "Canonical registration evidence unavailable",
                "application_registration_unsupported",
            );
        let returned: typeof manifest;
        try {
            returned = parseVersionedAppManifest(app.application_declaration, {
                allowLocal: declaration.environment === "lab",
            }).manifest;
        } catch {
            throw badReply();
        }
        if (!sameJson(manifest, returned)) throw badReply();
        current();
        return Object.freeze({
            id,
            name: manifest.name,
            manifestDigest: digest,
        });
    }
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            current();
            let response: Response | undefined;
            try {
                response = await fetcher(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                    signal: control.signal,
                    credentials: "omit",
                    redirect: "error",
                    cache: "no-store",
                    referrerPolicy: "no-referrer",
                });
                current();
                if (
                    response.redirected ||
                    (response.url && response.url !== url)
                )
                    throw badReply();
                if (!response.ok) {
                    await response.body?.cancel().catch(() => {});
                    if (transient.has(response.status)) throw unknown();
                    throw mdbaseError(
                        "forbidden",
                        "Application registration refused",
                        "application_registration_refused",
                    );
                }
                return receipt(await decode(response));
            } catch (error) {
                void response?.body?.cancel().catch(() => {});
                current();
                if (
                    error instanceof MdbaseError &&
                    error.reason !== "application_registration_unknown"
                )
                    throw error;
                if (attempt === 2) throw unknown();
                await new Promise<void>((resolve, reject) => {
                    const finish = () => {
                        clearTimeout(delay);
                        control.signal.removeEventListener("abort", finish);
                        try {
                            current();
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    };
                    const delay = setTimeout(
                        finish,
                        attempt === 0 ? 250 : 1000,
                    );
                    (delay as { unref?: () => void }).unref?.();
                    control.signal.addEventListener("abort", finish, {
                        once: true,
                    });
                    if (control.signal.aborted) finish();
                });
            }
        }
        throw unknown();
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        control.abort();
    }
}
