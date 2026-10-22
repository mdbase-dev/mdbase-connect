// SDK evidence codecs against existing Rust runtime golden bytes; not a native
// capture or browser qualification. Native capture/dispatch is tested in Rust.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

for (const first of ["runtime-wire"] as const) {
    describe(`pending runtime evidence (${first} imported first)`, () => {
        it("roundtrips FileAttach and legacy operations without widening Submit", async () => {
            vi.resetModules();
            await import("../src/runtime-wire.js");
            const wire = await import("../src/wire.js");
            const runtime = await import("../src/runtime-wire.js");
            const { decode, encode, toHex } = await import("../src/cbor.js");
            const original = runtime.runtimeMutation.dec(
                decode(
                    new Uint8Array(
                        readFileSync(
                            join(
                                import.meta.dirname,
                                "../../../conformance/wire/mutation/runtime-v1-mixed.cbor",
                            ),
                        ),
                    ),
                ),
            );
            const page = {
                pending: [
                    {
                        receipt: {
                            mutation: original.id,
                            state: "pending" as const,
                        },
                        captured: original.clock.instant,
                        ops: original.ops,
                    },
                ],
            };
            const encoded = wire.listPendingResult.enc(page);
            const actual = wire.listPendingResult.dec(decode(encode(encoded)));
            expect(actual).toEqual(page);
            expect(
                actual.pending[0]!.ops.some((op) => op.kind === "file_attach"),
            ).toBe(true);
            expect(toHex(encode(wire.listPendingResult.enc(actual)))).toBe(
                toHex(encode(encoded)),
            );
            expect(() => wire.mutation.enc(original as never)).toThrow();
            expect(() =>
                wire.op.enc(
                    original.ops.find(
                        (op) => op.kind === "file_attach",
                    )! as never,
                ),
            ).toThrow();
        });
    });
}

describe("pending runtime evidence", () => {
    it("refuses an unknown critical runtime arm instead of dropping a pending write", async () => {
        const wire = await import("../src/wire.js");
        const { decode } = await import("../src/cbor.js");
        const raw = decode(
            new Uint8Array(
                readFileSync(
                    join(
                        import.meta.dirname,
                        "../../../conformance/wire/mutation/runtime-v1-mixed.cbor",
                    ),
                ),
            ),
        ) as Map<number, unknown>;
        const operations = raw.get(6) as Map<number, unknown>[];
        const op = operations.find((op) => op.get(0) === 13)!;
        op.set(0, 19);
        const page = new Map([
            [
                0,
                [
                    new Map<number, unknown>([
                        [
                            0,
                            new Map([
                                [0, raw.get(0)],
                                [1, 0],
                            ]),
                        ],
                        [1, 0],
                        [2, [op]],
                    ]),
                ],
            ],
        ]);
        expect(() => wire.listPendingResult.dec(page as never)).toThrow();
    });
});
