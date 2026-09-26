import { describe, expect, it } from "vitest";
import { base64UrlBytes, bytesToBase64Url } from "./base64.js";

function reference(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("base64url", () => {
  it.each([0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 3 * 0x8000 + 2, 1_000_003])("round-trips %i bytes exactly", (size) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (index * 131 + 7) % 256;
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).toBe(reference(bytes));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlBytes(encoded)).toEqual(bytes);
  });

  it("uses the URL-safe alphabet", () => {
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  });
});
