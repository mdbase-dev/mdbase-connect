import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { either, tstr } from "../src/codec.js";
import { attachmentContentV1, attachmentRefV1, type AttachmentContentV1 } from "../src/attachment-wire.js";
import { attachmentContentV1 as runtimeAttachmentContent, attachmentRefV1 as runtimeAttachmentRef } from "../src/runtime-wire.js";
import { blobRef, hold, textOrBlob, type BlobRef, type Hold } from "../src/wire.js";
const id = "00112233-4455-6677-8899-aabbccddeeff";
const attachment: AttachmentContentV1 = {reference: {collection: id, keyEpoch: 7, attachmentId: new Uint8Array(32).fill(1), manifestCipherHash: `sha256:${"02".repeat(32)}`}, wholePlainHash: `sha256:${"03".repeat(32)}`, totalPlainBytes: 16_777_217};
const blob: BlobRef = {plainHash: `sha256:${"04".repeat(32)}`, size: 12, blobId: new Uint8Array(32).fill(5), idEpoch: 8, partSize: 10};
const binary = {form: "attachment" as const, content: attachment};
const held = (content: Hold["mine"]): Hold => ({id, path: "image.bin", reason: "conflict", since: 1790000000000, mine: content, saves: 2});
describe("closed complete AttachmentContentV1 Hold arm", () => {
  it("reuses ONE attachment codec without activating Submit/profile/crypto", () => {
    expect(runtimeAttachmentContent).toBe(attachmentContentV1); expect(runtimeAttachmentRef).toBe(attachmentRefV1);
  });
  it("keeps text and legacy BlobRef CBOR bytes exactly unchanged", () => {
    expect(encode(textOrBlob.enc("unchanged\u0000text"))).toEqual(encode(tstr.enc("unchanged\u0000text")));
    expect(encode(textOrBlob.enc(blob))).toEqual(encode(blobRef.enc(blob)));
    expect(textOrBlob.dec(decode(encode(textOrBlob.enc(blob))))).toEqual(blob);
  });
  it("encodes exact closed [1,complete attachment-content-v1] and preserves every identity", () => {
    const expected: CborValue = [1, attachmentContentV1.enc(attachment)];
    expect(encode(textOrBlob.enc(binary))).toEqual(encode(expected));
    expect(textOrBlob.dec(decode(encode(expected)))).toEqual(binary);
    const complete = {...held(binary), base: binary, theirs: binary};
    expect(hold.dec(decode(encode(hold.enc(complete))))).toEqual(complete);
  });
  it("legacy text/map-only readers refuse this WHOLE Hold, never flatten to BlobRef/text", () => {
    const legacy = either<string, BlobRef>("legacy-text-or-blob", tstr, (v): v is string => typeof v === "string", c => typeof c === "string", blobRef);
    const wire = hold.enc(held(binary)) as Map<number, CborValue>;
    expect(() => legacy.dec(wire.get(5)!)).toThrow(); expect(typeof textOrBlob.dec(wire.get(5)!)).toBe("object");
    expect(() => blobRef.dec(wire.get(5)!)).toThrow(); expect(() => tstr.dec(wire.get(5)!)).toThrow();
  });
  it.each([[], [1], [1, attachmentContentV1.enc(attachment), 0], [2, attachmentContentV1.enc(attachment)], [1, []], attachmentContentV1.enc(attachment)].map(value => ({value}))) ("refuses malformed/unknown outer arm $value", ({value}) => {
    expect(() => textOrBlob.dec(value as CborValue)).toThrow(); const wire = hold.enc(held("kept")) as Map<number, CborValue>; wire.set(5, value as CborValue); expect(() => hold.dec(wire)).toThrow();
  });
  it.each([4, 5, 6])("malformed optional/required Hold field %i refuses the whole object", key => {
    const content = attachmentContentV1.enc(attachment) as CborValue[], reference = content[1] as CborValue[]; reference[4] = 1024;
    const wire = hold.enc(held("kept")) as Map<number, CborValue>; wire.set(key, [1, content]); expect(() => hold.dec(wire)).toThrow();
  });
  it("roundtrips the actual native full-parent fixture with exact uint64 identities", () => {
    const bytes = Uint8Array.from(Buffer.from(readFileSync(new URL("./fixtures/native-attachment-hold.hex", import.meta.url), "utf8").trim(), "hex"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("ce289c313f3041eccd7408cdfcbc75972005ac3421cef15a166664c157321a3e");
    const decoded = hold.dec(decode(bytes));
    expect(decoded.id).toBe("09090909-0909-0909-0909-090909090909");
    expect(decoded.path).toBe("files/held.bin");
    expect(decoded.reason).toBe("conflict"); expect(decoded.since).toBe(42); expect(decoded.saves).toBe(1);
    for (const side of [decoded.base, decoded.mine, decoded.theirs]) {
      expect(side).toEqual({form: "attachment", content: {
        reference: {collection: "01010101-0101-0101-0101-010101010101", keyEpoch: 0xffffffffffffffffn, attachmentId: new Uint8Array(32).fill(2), manifestCipherHash: `sha256:${"03".repeat(32)}`},
        wholePlainHash: `sha256:${"04".repeat(32)}`, totalPlainBytes: 0xffffffffffffffffn,
      }});
    }
    expect(encode(hold.enc(decoded))).toEqual(bytes);
    const legacy = either<string, BlobRef>("legacy-text-or-blob", tstr, (v): v is string => typeof v === "string", c => typeof c === "string", blobRef);
    const parent = decode(bytes) as Map<number, CborValue>;
    for (const key of [4, 5, 6]) expect(() => legacy.dec(parent.get(key)!)).toThrow();
  });
  it.each([-1, -1n, 0x10000000000000000n, Number.MAX_SAFE_INTEGER + 1, 1.5, Infinity, NaN])("refuses non-u64 attachment epoch/size %s without rounding", bad => {
    expect(() => attachmentContentV1.enc({...attachment, totalPlainBytes: bad})).toThrow();
    expect(() => attachmentRefV1.enc({...attachment.reference, keyEpoch: bad})).toThrow();
    const c = attachmentContentV1.enc(attachment) as CborValue[];
    expect(() => attachmentContentV1.dec([...c.slice(0, 3), bad])).toThrow();
    const ref = c[1] as CborValue[];
    expect(() => attachmentRefV1.dec([ref[0]!, ref[1]!, bad, ...ref.slice(3)])).toThrow();
  });
  it("rejects truncated/missing typed reference, out-of-u64 counts and unknown version", () => {
    const c = attachmentContentV1.enc(attachment) as CborValue[];
    const ref = c[1] as CborValue[];
    for (const bad of [[1, c.slice(0, 3)], [1, [...c, 0]], [1, [2, ...c.slice(1)]], [1, [1, ref.slice(0, 5), c[2]!, c[3]!]], [1, [1, ref, c[2]!, 0x10000000000000000n]]]) expect(() => textOrBlob.dec(bad)).toThrow();
  });
});
