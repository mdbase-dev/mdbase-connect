// SDK grammar/validation over actual SDK clients and controlled query replies.
// Native producer proof is the separate actual SQLite/Frames Rust regression;
// these replies are NOT immutable-source, runtime/archive or browser/LAB qualification.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { decode, fromHex } from "../src/cbor.js";
import { toPlain } from "../src/values.js";
import {
    connect,
    resolveRecordLinks,
    MdbaseError,
    type MdbaseClient,
    type QueryResult,
} from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
const clients: MdbaseClient[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.close();
});
async function fixture() {
    const replica = new MemoryReplica();
    const record = replica.seed({
        path: "Tasks/First.md",
        frontmatter: { "Crew Links": ["[[People/Alex|Alias]]", "[[Missing]]"] },
    });
    const client = await connect({
        connector: replica.connector(),
        app: { name: "record-links", version: "test" },
        reconnect: false,
    });
    clients.push(client);
    const source = await client.get(record.id);
    function reply(
        raw: unknown = ["[[People/Alex|Alias]]", "[[Missing]]"],
        paths: unknown = ["People/Alex.md", null],
    ): QueryResult {
        return {
            records: [
                {
                    ...source,
                    values: new Map([
                        ["raw", raw],
                        ["paths", paths],
                    ]) as QueryResult["records"][number]["values"],
                },
            ],
            complete: true,
            asOf: 1,
            columns: ["raw", "paths"],
        };
    }
    return { client, source, reply };
}
const nativeQueries = toPlain(
    decode(
        fromHex(
            readFileSync(
                new URL(
                    "./fixtures/native-record-links-query.hex",
                    import.meta.url,
                ),
                "utf8",
            ).trim(),
        ),
    ),
) as unknown as {
    cases: { name: string; path: string; field: string; query: unknown }[];
};
it.each(nativeQueries.cases)(
    "exact generated request $name matches the fixture consumed by the real native SQLite producer",
    async (original) => {
        const f = await fixture();
        const query = vi
            .spyOn(f.client, "query")
            .mockResolvedValue({
                ...f.reply(),
                records: [{ ...f.reply().records[0]!, path: original.path }],
            });
        await resolveRecordLinks(f.client, {
            path: original.path,
            field: original.field,
        });
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0]?.[0]).toEqual(original.query);
    },
);
it("one original ordinary query preserves raw links, aliases, nulls, duplicates and order", async () => {
    const f = await fixture();
    const raw = [
        "[[People/Alex|Alias]]",
        "[[Missing]]",
        "[[People/Alex|Alias]]",
    ];
    const query = vi
        .spyOn(f.client, "query")
        .mockResolvedValue(
            f.reply(raw, ["People/Alex.md", null, "People/Alex.md"]),
        );
    const result = await resolveRecordLinks(f.client, {
        path: f.source.path,
        field: "Crew Links",
    });
    expect(result).toEqual([
        { raw: raw[0], path: "People/Alex.md" },
        { raw: raw[1], path: null },
        { raw: raw[2], path: "People/Alex.md" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatchObject({
        where: 'file.path == "Tasks/First.md"',
        limit: 2,
    });
    const select = query.mock.calls[0]?.[0].select as {
        name: string;
        expr: string;
    }[];
    expect(select.map((s) => s.name)).toEqual(["raw", "paths"]);
    expect(select[0]?.expr).toContain('raw["Crew Links"]');
    expect(select[1]?.expr).toContain(".asFile()");
    expect(query.mock.calls[0]?.[1]).toBeUndefined();
});
it.each([
    [
        "[[Alex]]",
        ["People/Alex.md"],
        [{ raw: "[[Alex]]", path: "People/Alex.md" }],
    ],
    [null, [], []],
])(
    "validates scalar/null/empty native projection",
    async (raw, paths, expected) => {
        const f = await fixture();
        vi.spyOn(f.client, "query").mockResolvedValue(f.reply(raw, paths));
        expect(
            await resolveRecordLinks(f.client, {
                path: f.source.path,
                field: "Crew Links",
            }),
        ).toEqual(expected);
    },
);
it.each([
    (r: QueryResult) => ({ ...r, complete: false }),
    (r: QueryResult) => ({
        ...r,
        records: [{ ...r.records[0]!, path: "Other.md" }],
    }),
    (r: QueryResult) => ({
        ...r,
        records: [
            {
                ...r.records[0]!,
                values: new Map([
                    ["raw", ["[[Alex]]"]],
                    ["paths", []],
                ]),
            },
        ],
    }),
    (r: QueryResult) => ({
        ...r,
        records: [
            {
                ...r.records[0]!,
                values: new Map([
                    ["raw", [42]],
                    ["paths", [null]],
                ]),
            },
        ],
    }),
    (r: QueryResult) => ({
        ...r,
        diagnostics: [
            {
                code: "expression_evaluation_error",
                severity: "warning" as const,
                message: "controlled native evaluation error",
            },
        ],
    }),
])(
    "partial/changed/misaligned/invalid/evaluation-error evidence never delivers success",
    async (alter) => {
        const f = await fixture();
        vi.spyOn(f.client, "query").mockResolvedValue(alter(f.reply()));
        await expect(
            resolveRecordLinks(f.client, {
                path: f.source.path,
                field: "Crew Links",
            }),
        ).rejects.toBeInstanceOf(MdbaseError);
    },
);
it("preserves original native refusal/budget identity without more READs", async () => {
    const f = await fixture();
    const failure = new MdbaseError({
        code: "too_large",
        recovery: "fix_request",
        reason: "query_budget_exceeded",
        message: "controlled original refusal",
    });
    const query = vi.spyOn(f.client, "query").mockRejectedValue(failure);
    await expect(
        resolveRecordLinks(f.client, {
            path: f.source.path,
            field: "Crew Links",
        }),
    ).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
});
it("fences a changed original binding and caller cancellation after late reply", async () => {
    const f = await fixture();
    let current = true;
    let release!: (reply: QueryResult) => void;
    vi.spyOn(f.client, "query").mockImplementation(
        () =>
            new Promise((r) => {
                release = r;
            }),
    );
    const first = resolveRecordLinks(
        f.client,
        { path: f.source.path, field: "Crew Links" },
        { isCurrent: () => current },
    );
    current = false;
    release(f.reply());
    await expect(first).rejects.toMatchObject({
        reason: "record_links_fenced",
    });
    const controller = new AbortController(),
        reason = new Error("caller abort");
    const second = resolveRecordLinks(
        f.client,
        { path: f.source.path, field: "Crew Links" },
        { signal: controller.signal },
    );
    controller.abort(reason);
    release(f.reply());
    await expect(second).rejects.toBe(reason);
});
it("missing record is not_found, while missing selection values are unsupported, never fake empty links", async () => {
    const f = await fixture(),
        query = vi.spyOn(f.client, "query");
    query.mockResolvedValueOnce({ ...f.reply(), records: [] });
    await expect(
        resolveRecordLinks(f.client, {
            path: f.source.path,
            field: "Crew Links",
        }),
    ).rejects.toMatchObject({
        code: "not_found",
        reason: "record_links_missing",
    });
    query.mockResolvedValueOnce({ ...f.reply(), records: [f.source] });
    await expect(
        resolveRecordLinks(f.client, {
            path: f.source.path,
            field: "Crew Links",
        }),
    ).rejects.toMatchObject({
        code: "upgrade_required",
        reason: "record_links_unsupported",
    });
    expect(query).toHaveBeenCalledTimes(2);
});
it.each([
    (f: Awaited<ReturnType<typeof fixture>>) =>
        f.reply(Array(1001).fill("[[Alex]]"), Array(1001).fill(null)),
    (f: Awaited<ReturnType<typeof fixture>>) =>
        f.reply(["é".repeat((1 << 19) + 1)], [null]),
    (f: Awaited<ReturnType<typeof fixture>>) => f.reply(new Array(1), [null]),
])(
    "slot/UTF-8 output bounds and sparse or incomplete arrays fail closed",
    async (reply) => {
        const f = await fixture(),
            query = vi.spyOn(f.client, "query").mockResolvedValue(reply(f));
        await expect(
            resolveRecordLinks(f.client, {
                path: f.source.path,
                field: "Crew Links",
            }),
        ).rejects.toMatchObject({ reason: "record_links_response" });
        expect(query).toHaveBeenCalledTimes(1);
    },
);
it("invalid inputs and pre-aborted/currentness-failed calls perform no READ", async () => {
    const f = await fixture(),
        query = vi.spyOn(f.client, "query");
    for (const selection of [
        { path: "", field: "x" },
        { path: f.source.path, field: "" },
        { path: "é".repeat(2049), field: "x" },
    ]) {
        await expect(
            resolveRecordLinks(f.client, selection),
        ).rejects.toMatchObject({ reason: "record_links_bounds" });
    }
    await expect(
        resolveRecordLinks(
            f.client,
            { path: f.source.path, field: "x" },
            { signal: AbortSignal.abort() },
        ),
    ).rejects.toHaveProperty("name", "AbortError");
    await expect(
        resolveRecordLinks(
            f.client,
            { path: f.source.path, field: "x" },
            { isCurrent: () => false },
        ),
    ).rejects.toMatchObject({ reason: "record_links_fenced" });
    expect(query).not.toHaveBeenCalled();
});
