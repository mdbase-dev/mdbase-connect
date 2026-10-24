import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { either, tstr } from "../src/codec.js";
import { attachmentContentV1, type AttachmentContentV1 } from "../src/attachment-wire.js";
import { blobRef, hold, textOrBlob, type BlobRef, type Hold } from "../src/wire.js";
const id = "00112233-4455-6677-8899-aabbccddeeff";
const attachment: AttachmentContentV1 = {reference: {collection: id, keyEpoch: 7, attachmentId: new Uint8Array(32).fill(1), manifestCipherHash: `sha256:${"02".repeat(32)}`}, wholePlainHash: `sha256:${"03".repeat(32)}`, totalPlainBytes: 16_777_217};
const blob: BlobRef = {plainHash: `sha256:${"04".repeat(32)}`, size: 12, blobId: new Uint8Array(32).fill(5), idEpoch: 8, partSize: 10};
const held = (content: Hold["mine"]): Hold => ({id, path: "image.bin", reason: "conflict", since: 1790000000000, mine: content, saves: 2});
describe("closed complete AttachmentContentV1 Hold arm", () => {
  it("keeps text and legacy BlobRef CBOR bytes exactly unchanged", () => {
    expect(encode(textOrBlob.enc("unchanged\u0000text"))).toEqual(encode(tstr.enc("unchanged\u0000text")));
    expect(encode(textOrBlob.enc(blob))).toEqual(encode(blobRef.enc(blob)));
    expect(textOrBlob.dec(decode(encode(textOrBlob.enc(blob))))).toEqual(blob);
  });
  it.each([[2, attachmentContentV1.enc(attachment)], attachmentContentV1.enc(attachment)].map(value => ({value}))) ("refuses malformed/unknown outer arm $value", ({value}) => {
    expect(() => textOrBlob.dec(value as CborValue)).toThrow(); const wire = hold.enc(held("kept")) as Map<number, CborValue>; wire.set(5, value as CborValue); expect(() => hold.dec(wire)).toThrow();
  });
  it.each([5])("malformed required Hold field %i refuses the whole object", key => {
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
});
