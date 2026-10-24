import { describe, expect, it } from "vitest";
import { CborError, decode, encode, Float64, toHex } from "../src/cbor.js";
import { record, RecordReader } from "../src/transport/port.js";

const rt = (v: Parameters<typeof encode>[0]) => decode(encode(v));

describe("mdb-cbor/1", () => {
  it("encodes integers in shortest form", () => {
    expect(toHex(encode(23))).toBe("17");
    expect(toHex(encode(24))).toBe("1818");
    expect(toHex(encode(256))).toBe("190100");
    expect(toHex(encode(-1))).toBe("20");
    expect(toHex(encode(2 ** 32))).toBe("1b0000000100000000");
    expect(toHex(encode(-(2n ** 63n)))).toBe("3b7fffffffffffffff");
    expect(toHex(encode(2n ** 64n - 1n))).toBe("1bffffffffffffffff");
  });


  it("keeps 1 and 1.0 distinct", () => {
    expect(toHex(encode(1))).toBe("01");
    expect(toHex(encode(new Float64(1)))).toBe("fb3ff0000000000000");
    expect(rt(new Float64(1))).toEqual(new Float64(1));
    expect(rt(1.5)).toBe(1.5);
    const negZero = rt(-0) as Float64;
    expect(negZero).toBeInstanceOf(Float64);
    expect(Object.is(negZero.value, -0)).toBe(true);
  });

  it("rejects non-finite floats on encode", () => {
    expect(() => encode(NaN)).toThrow(CborError);
    expect(() => encode(Infinity)).toThrow(CborError);
  });



  it("refuses to encode unsorted struct maps or duplicate data keys", () => {
    expect(() =>
      encode(
        new Map([
          [2, null],
          [1, null],
        ]),
      ),
    ).toThrow(CborError);
  });

  it("rejects lone surrogates in text", () => {
    expect(() => encode("\ud800")).toThrow(CborError);
  });

  it("bounds depth", () => {
    const b = new Uint8Array(130).fill(0x81);
    b[129] = 0;
    expect(() => decode(b)).toThrow(CborError);
  });
});

describe("record framing", () => {
  it("reassembles frames split across many chunks, in linear time", () => {
    const r = new RecordReader();
    const frames = [new Uint8Array(100_000).fill(7), new Uint8Array(3).fill(1), new Uint8Array(0)];
    const stream = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
    let o = 0;
    for (const f of frames) {
      stream.set(record(f), o);
      o += 4 + f.length;
    }
    const out: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 7) out.push(...r.push(stream.subarray(i, i + 7)));
    expect(out.map((f) => f.length)).toEqual([100_000, 3, 0]);
    expect(out[0]!.every((b) => b === 7)).toBe(true);
  });
  it("rejects an oversized length prefix", () => {
    const r = new RecordReader();
    expect(() => r.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow();
  });
});
