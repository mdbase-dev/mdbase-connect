import type { MdbaseClient, PagesOptions, Query, RecordRef } from "./client.js";
import { uuid } from "./codec.js";
import { mdbaseError } from "./errors.js";
import type { Include, QueryResult, RecordView } from "./wire.js";

export const READ_MANY_MAX_REFS = 1000;
export const READ_MANY_MAX_CONCURRENCY = 16;
export interface ReadManyOptions {
    /** 1..16 ordinary get calls in flight (default 8). */
    concurrency?: number;
}

/** Ordered ordinary reads, not a transaction or a consistent native snapshot.
 * Duplicate selections remain separate calls/slots. A failure stops scheduling;
 * all already-started calls settle before the original error is delivered. */
export async function readMany(
    client: Pick<MdbaseClient, "get">,
    refs: readonly RecordRef[],
    include?: Include,
    signal?: AbortSignal,
    options: ReadManyOptions = {},
): Promise<RecordView[]> {
    signal?.throwIfAborted();
    const concurrency = options.concurrency ?? 8;
    if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > READ_MANY_MAX_CONCURRENCY
    ) {
        throw mdbaseError(
            "invalid_request",
            "readMany concurrency must be 1..16",
            "read_many_bounds",
        );
    }
    if (!Array.isArray(refs) || refs.length > READ_MANY_MAX_REFS) {
        throw mdbaseError(
            "invalid_request",
            "readMany accepts at most 1000 record selections",
            "read_many_bounds",
        );
    }
    // Capture every selector before any get/await. A view selects its UUID, not
    // its possibly stale path/revision; no input is promoted to a native witness.
    const selections = Array.from(refs, capture);
    const capturedInclude = include ? Object.freeze({ ...include }) : undefined;
    const records = new Array<RecordView>(selections.length);
    let next = 0,
        failed = false,
        failure: unknown;
    async function worker(): Promise<void> {
        while (!failed && next < selections.length) {
            try {
                signal?.throwIfAborted();
                const index = next++,
                    selected = selections[index]!;
                const record = await client.get(
                    selected,
                    capturedInclude,
                    signal,
                );
                signal?.throwIfAborted();
                if (failed) return;
                if (typeof selected === "string" && record.id !== selected) {
                    throw mdbaseError(
                        "invalid_request",
                        "readMany readback belongs to another UUID",
                        "read_many_identity_mismatch",
                    );
                }
                records[index] = record;
            } catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                }
                return;
            }
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, selections.length) }, () =>
            worker(),
        ),
    );
    if (failed) throw failure;
    signal?.throwIfAborted();
    return records;
}

function capture(ref: RecordRef): RecordRef {
    if (typeof ref === "string") return uuid.dec(uuid.enc(ref));
    if (!ref || typeof ref !== "object") {
        throw mdbaseError(
            "invalid_request",
            "readMany needs UUID, path or record selections",
            "read_many_selection",
        );
    }
    if ("id" in ref) return uuid.dec(uuid.enc(ref.id));
    if (
        typeof ref.path !== "string" ||
        ref.path.length === 0 ||
        ref.path.length > 4096 ||
        new TextEncoder().encode(ref.path).byteLength > 4096
    ) {
        throw mdbaseError(
            "invalid_request",
            "readMany path must be nonempty and at most 4096 UTF-8 bytes",
            "read_many_bounds",
        );
    }
    return Object.freeze({ path: ref.path });
}

/** Alias the canonical paginator. Preserve whole pages, original opaque cursors,
 * Include/signal and explicit onReset semantics; never flatten or auto-reset. */
export function queryPages(
    client: Pick<MdbaseClient, "pages">,
    query: Query,
    include?: Include,
    signal?: AbortSignal,
    options: PagesOptions = {},
): AsyncGenerator<QueryResult> {
    return client.pages(query, include, signal, options);
}

/** Resolve a persisted flat frontmatter key through ONE ordinary native query.
 * Raw scalar/list strings retain order, duplicates and display aliases; null
 * targets mean native unresolved/ambiguous/non-record links, never a Person or
 * author inference. Missing/null/empty-list fields yield [] only from a validated
 * complete native projection. Old producers fail unsupported, without fallback.
 * `isCurrent` may bind an original caller scope/revision; this is not a historical
 * witness, snapshot subscription, extra READ or replacement client. */
export async function resolveRecordLinks(
    client: Pick<MdbaseClient, "query">,
    selection: { readonly path: string; readonly field: string },
    options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<readonly Readonly<{ raw: string; path: string | null }>[]> {
    const signal = options.signal;
    const current = options.isCurrent?.bind(options);
    const fenced = () =>
        mdbaseError(
            "unavailable",
            "original record link binding changed",
            "record_links_fenced",
        );
    function cut() {
        signal?.throwIfAborted();
        if (current) {
            let valid = false;
            try {
                valid = current() === true;
            } catch {
                /* no callback diagnostics */
            }
            if (!valid) throw fenced();
        }
    }
    cut();
    const path = selection?.path,
        field = selection?.field;
    const text = (value: unknown): value is string =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 4096 &&
        new TextEncoder().encode(value).byteLength <= 4096;
    if (!text(path) || !text(field)) {
        throw mdbaseError(
            "invalid_request",
            "record link path/field must be nonempty and bounded",
            "record_links_bounds",
        );
    }
    const key = JSON.stringify(field);
    const raw = `(${key} in raw ? raw[${key}] : null)`;
    const target = (value: string) =>
        `${value}.asFile() == null ? null : ${value}.asFile().file.path`;
    // Canonical Core CEL type() returns a string, not CEL type constants.
    const paths = `${raw} == null ? [] : type(${raw}) == "list" ? ${raw}.map(l, ${target("l")}) : [${target(raw)}]`;
    if (new TextEncoder().encode(paths).byteLength > 64 * 1024) {
        throw mdbaseError(
            "invalid_request",
            "record link expression exceeds native source bound",
            "record_links_bounds",
        );
    }
    cut();
    const result = await client.query(
        {
            where: `file.path == ${JSON.stringify(path)}`,
            limit: 2,
            select: [
                { name: "raw", expr: raw },
                { name: "paths", expr: paths },
            ],
        },
        undefined,
        signal,
    );
    cut();
    const invalid = () =>
        mdbaseError(
            "unavailable",
            "invalid or incomplete native record link projection",
            "record_links_response",
        );
    if (result.complete !== true || result.cursor != null) throw invalid();
    if (result.columns === undefined) {
        throw mdbaseError(
            "upgrade_required",
            "native record link projection unsupported",
            "record_links_unsupported",
        );
    }
    if (
        result.columns.length !== 2 ||
        result.columns[0] !== "raw" ||
        result.columns[1] !== "paths" ||
        result.diagnostics?.some(
            (issue) => issue.code === "expression_evaluation_error",
        )
    )
        throw invalid();
    if (result.records.length === 0) {
        throw mdbaseError(
            "not_found",
            "selected record not found",
            "record_links_missing",
        );
    }
    if (result.records.length !== 1 || result.records[0]!.path !== path)
        throw invalid();
    const values = result.records[0]!.values;
    if (values === undefined) {
        throw mdbaseError(
            "upgrade_required",
            "native record link projection unsupported",
            "record_links_unsupported",
        );
    }
    if (
        !(values instanceof Map) ||
        values.size !== 2 ||
        !values.has("raw") ||
        !values.has("paths")
    )
        throw invalid();
    const original = values.get("raw"),
        resolved = values.get("paths");
    const links =
        original === null
            ? []
            : typeof original === "string"
              ? [original]
              : original;
    if (
        !Array.isArray(links) ||
        !Array.isArray(resolved) ||
        links.length !== resolved.length ||
        links.length > 1000
    )
        throw invalid();
    let bytes = 0;
    const entries: Readonly<{ raw: string; path: string | null }>[] = [];
    for (let index = 0; index < links.length; index++) {
        const raw = links[index],
            path = resolved[index];
        if (
            typeof raw !== "string" ||
            raw.length > (1 << 20) - bytes ||
            (path !== null && !text(path))
        )
            throw invalid();
        bytes +=
            new TextEncoder().encode(raw).byteLength +
            (path === null ? 0 : new TextEncoder().encode(path).byteLength);
        if (bytes > 1 << 20) throw invalid();
        entries.push(Object.freeze({ raw, path: path as string | null }));
    }
    cut();
    return Object.freeze(entries);
}
