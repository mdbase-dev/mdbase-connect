// Controlled protocol replies test the public SDK, not a native validator,
// SQL, app acceptance, browser or operational qualification.
import { afterEach, describe, it, expect, vi } from "vitest";
import {
    connect,
    type MdbaseClient,
    type RecordRef,
    type RecordValidation,
    wire,
    SchemaError,
} from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { recordValidations } from "../src/validation.js";
import { uuid } from "../src/codec.js";
import { type CborValue, encode, decode } from "../src/cbor.js";
const clients: MdbaseClient[] = [];
afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    vi.restoreAllMocks();
});
async function fixture(features?: string[]) {
    const replica = new MemoryReplica(features ? { features } : {}),
        a = replica.seed({ path: "tasks/a.md", body: "A\n" }),
        b = replica.seed({ path: "tasks/b.md", body: "B\n" });
    let reply: CborValue | undefined, problem: wire.Problem | undefined;
    const replies: CborValue[] = [];
    let deliver: (() => void) | undefined;
    let hold = false,
        afterDelivery: (() => void) | undefined;
    const calls: CborValue[] = [];
    const original = replica.connector();
    const client = await connect({
        app: { name: "validation-test", version: "test" },
        reconnect: false,
        connector: {
            description: "controlled validation replies",
            async open(hello, signal) {
                const opened = await original.open(hello, signal),
                    port = opened.port,
                    send = port.send.bind(port);
                port.send = (raw) => {
                    const f = wire.clientFrame.dec(raw);
                    if (f.kind !== "request" || f.method !== "validate") {
                        send(raw);
                        return;
                    }
                    calls.push(f.params);
                    deliver = () => {
                        port.onframe?.(
                            wire.clientFrame.enc({
                                kind: "response",
                                id: f.id,
                                ...(problem
                                    ? { problem }
                                    : { result: replies.shift() ?? reply ?? null }),
                            }),
                        );
                        afterDelivery?.();
                    };
                    if (!hold) queueMicrotask(() => deliver?.());
                };
                return opened;
            },
        },
    });
    clients.push(client);
    const seen = await client.get(a.id, { document: true }),
        other = await client.get(b.id, { document: true });
    function row(
        view = seen,
        issues: RecordValidation["issues"] = [],
    ): RecordValidation {
        return {
            id: view.id,
            path: view.path,
            revision: view.revision,
            issues,
        };
    }
    return {
        client,
        replica,
        seen,
        other,
        calls,
        row,
        setReply: (v: CborValue) => {
            reply = v;
        },
        queueReplies: (...v: CborValue[]) => {
            replies.push(...v);
        },
        setProblem: (p: wire.Problem) => {
            problem = p;
        },
        hold: () => {
            hold = true;
        },
        deliver: () => deliver?.(),
        after: (f: () => void) => {
            afterDelivery = f;
        },
    };
}
const diagnostic: RecordValidation["issues"][number] = {
    code: "schema_type",
    severity: "warning",
    message: "Expected boolean",
    location: "/done",
    typeName: "Task",
    tier: "single_record",
    details: new Map([["schema_location", "/properties/done/type"]]),
};
describe("public current-record validation", () => {
    it("decodes complete native witnesses/diagnostics and preserves selection order/duplicates/signal", async () => {
        const f = await fixture();
        f.setReply(
            decode(
                encode(
                    recordValidations.enc([
                        f.row(f.other, [diagnostic]),
                        f.row(),
                        f.row(f.other),
                    ]),
                ),
            ),
        );
        const signal = new AbortController().signal,
            call = vi.spyOn(f.client, "call");
        const out = await f.client.validate(
            [f.other.id, { path: f.seen.path }, f.other],
            signal,
        );
        expect(out).toEqual([
            f.row(f.other, [diagnostic]),
            f.row(),
            f.row(f.other),
        ]);
        expect(call.mock.calls[0]?.[2]).toMatchObject({
            signal,
            retry: true,
            codec: recordValidations,
        });
        expect(f.calls[0]).toEqual(
            new Map([
                [0, [uuid.enc(f.other.id), f.seen.path, uuid.enc(f.other.id)]],
            ]),
        );
    });
    it("captures IDs/path/revision before ready/dispatch and refuses a stale view without refresh", async () => {
        const f = await fixture();
        f.hold();
        f.setReply(recordValidations.enc([f.row(), f.row()]));
        const path = { path: f.seen.path },
            view = { ...f.seen };
        const pending = f.client.validate([view, path]);
        view.id = f.other.id;
        view.revision = f.other.revision;
        path.path = "changed.md";
        await vi.waitFor(() => expect(f.calls).toHaveLength(1));
        f.deliver();
        expect(await pending).toEqual([f.row(), f.row()]);
        expect(f.calls[0]).toEqual(
            new Map([[0, [uuid.enc(f.seen.id), f.seen.path]]]),
        );
        f.setReply(
            recordValidations.enc([
                { ...f.row(), revision: "sha256:" + "11".repeat(32) },
            ]),
        );
        const stale = f.client.validate([f.seen]);
        await vi.waitFor(() => expect(f.calls).toHaveLength(2));
        f.deliver();
        await expect(stale).rejects.toMatchObject({
            code: "unavailable",
            reason: "record_validation_stale",
        });
        expect(f.calls).toHaveLength(2);
    });
    it.each(["partial", "identity"])(
        "refuses %s inventory without omission or empty fallback",
        async (kind) => {
            const f = await fixture();
            const rows =
                kind === "partial"
                    ? []
                    : kind === "extra"
                      ? [f.row(), f.row()]
                      : [f.row(f.other)];
            f.setReply(recordValidations.enc(rows));
            await expect(f.client.validate([f.seen.id])).rejects.toMatchObject({
                code: "internal",
                reason: "invalid_validation_result",
            });
            expect(f.calls).toHaveLength(1);
        },
    );
    it("preserves collection/empty-batch semantics only with actual complete native replies", async () => {
        const f = await fixture();
        f.setReply(recordValidations.enc([f.row()]));
        expect(await f.client.validate()).toEqual([f.row()]);
        expect(f.calls[0]).toEqual(new Map());
        f.setReply([]);
        expect(await f.client.validate([])).toEqual([]);
        expect(f.calls[1]).toEqual(new Map([[0, []]]));
        f.setReply(null);
        await expect(f.client.validate()).rejects.toMatchObject({
            code: "internal",
        });
    });
    it("pages every record after the last one when the replica grants validate-page-v1", async () => {
        const f = await fixture(["validate-page-v1"]);
        expect(f.client.hello.features).toContain("validate-page-v1");
        f.queueReplies(
            recordValidations.enc([f.row(), f.row(f.other)]),
            recordValidations.enc([f.row(f.other, [diagnostic])]),
            [],
        );
        expect(await f.client.validate()).toEqual([
            f.row(),
            f.row(f.other),
            f.row(f.other, [diagnostic]),
        ]);
        expect(f.calls).toEqual([
            new Map([[1, new Map()]]),
            new Map([[1, new Map([[0, uuid.enc(f.other.id)]])]]),
            new Map([[1, new Map([[0, uuid.enc(f.other.id)]])]]),
        ]);
        // Selections stay one request.
        f.setReply(recordValidations.enc([f.row()]));
        expect(await f.client.validate([f.seen.id])).toEqual([f.row()]);
        expect(f.calls[3]).toEqual(new Map([[0, [uuid.enc(f.seen.id)]]]));
    });
    it("pre-abort and final delivery abort preserve original cancellation, including empty replies", async () => {
        const f = await fixture();
        const pre = new AbortController();
        pre.abort(new Error("original pre-abort"));
        await expect(f.client.validate([], pre.signal)).rejects.toBe(
            pre.signal.reason,
        );
        expect(f.calls).toHaveLength(0);
        const final = new AbortController(),
            reason = new Error("original delivery abort");
        f.setReply([]);
        f.after(() => final.abort(reason));
        await expect(f.client.validate([], final.signal)).rejects.toBe(reason);
    });
    it("bounds and validates all input selections before dispatch", async () => {
        const f = await fixture();
        for (const refs of [
            Array(1001).fill(f.seen.id),
            Array(2),
            [f.seen.id, { path: "" }],
            [{ path: "é".repeat(2049) }],
            [undefined],
        ] as unknown as RecordRef[][])
            await expect(f.client.validate(refs)).rejects.toBeDefined();
        expect(f.calls).toHaveLength(0);
    });
});
describe("bounded validation codec", () => {
    it("rejects missing diagnostics or native witnesses, malformed diagnostics, and unknown tier/severity", async () => {
        const f = await fixture();
        const base = recordValidations.enc([
            f.row(f.seen, [diagnostic]),
        ]) as Map<number, CborValue>[];
        for (const field of [0, 1, 2, 3]) {
            const row = new Map(base[0]);
            row.delete(field);
            expect(() => recordValidations.dec([row])).toThrow(SchemaError);
        }
        for (const field of [0, 1, 2, 6]) {
            const row = new Map(base[0]),
                issues = (row.get(1) as Map<number, CborValue>[]).map(
                    (i) => new Map(i),
                );
            issues[0]!.delete(field);
            row.set(1, issues);
            expect(() => recordValidations.dec([row])).toThrow(SchemaError);
        }
        const issue = (base[0]!.get(1) as Map<number, CborValue>[])[0]!;
        for (const [key, bad] of [
            [1, 99],
            [6, "future_tier"],
        ] as const) {
            const changed = new Map(issue);
            changed.set(key, bad);
            const row = new Map(base[0]);
            row.set(1, [changed]);
            expect(() => recordValidations.dec([row])).toThrow(SchemaError);
        }
    });
    it("preflights inventory/diagnostic/tree/depth/byte/path bounds", async () => {
        const f = await fixture();
        const row = (
            recordValidations.enc([f.row()]) as Map<number, CborValue>[]
        )[0]!;
        expect(() => recordValidations.dec(Array(1001).fill(row))).toThrow(
            SchemaError,
        );
        const many = new Map(row);
        many.set(1, Array(4097).fill(new Map()));
        expect(() => recordValidations.dec([many])).toThrow(SchemaError);
        const wide = new Map(row);
        wide.set(99, Array(65537).fill(null));
        expect(() => recordValidations.dec([wide])).toThrow(SchemaError);
        let deep: CborValue = null;
        for (let i = 0; i < 33; i++) deep = [deep];
        const nested = new Map(row);
        nested.set(99, deep);
        expect(() => recordValidations.dec([nested])).toThrow(SchemaError);
        const huge = new Map(row);
        huge.set(99, "X".repeat(1024 * 1024));
        expect(() => recordValidations.dec([huge])).toThrow(SchemaError);
        const path = new Map(row);
        path.set(2, "é".repeat(2049));
        expect(() => recordValidations.dec([path])).toThrow(SchemaError);
    });
});
