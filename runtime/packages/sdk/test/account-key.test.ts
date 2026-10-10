import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AccountKeyError, accountKeyRewrapDigest, checkKdfParams, checkRecoveryKey, decodeBundle, deriveAccountKeyProof, deriveRecoveryDevice,
  domainHash, encodeBundle, formatRecoveryKey, generateRecoveryKey, keyId, normalizePassword, openBundle, parseRecoveryKey, sealBundle,
  signAccountKeyRewrap, type Bundle,
} from "../src/account-key.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { fromHex, toHex } from "../src/cbor.js";

const vector = (dir: string) =>
  JSON.parse(readFileSync(new URL(`../../../conformance/crypto/${dir}/vector-1.json`, import.meta.url), "utf8"));
const PASSWORD = "correct horse battery staple";
const ACCOUNT = "07070707-0707-0707-0707-070707070707";
const counter = (seed: number) => (n: number) => new Uint8Array(n).map((_, i) => (seed + i) & 0xff);
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AccountKeyError ? e.code : `other:${String(e)}`));

describe("recovery key text (conformance/crypto/recovery-key)", () => {
  const v = vector("recovery-key");
  it("formats and parses the shared vector, with look-alikes and spacing", () => {
    const secret = fromHex(v.secret);
    expect(formatRecoveryKey(secret)).toBe(v.text);
    expect(toHex(parseRecoveryKey(v.text))).toBe(v.secret);
    for (const t of v.also_parses) expect(toHex(parseRecoveryKey(t))).toBe(v.secret);
    for (const t of v.rejects) expect(() => parseRecoveryKey(t)).toThrow(AccountKeyError);
  });
  it("derives the exact recovery device", () => {
    const d = deriveRecoveryDevice(fromHex(v.secret), v.collection);
    expect(toHex(d.signPk)).toBe(v.sign_pk);
    expect(toHex(d.kemPk)).toBe(v.kem_pk);
    expect(d.device).toBe(v.device);
    expect(toHex(d.noisePk)).toBe(v.noise_pk);
  });
  it("round-trips fresh keys and reports typos by reason", () => {
    const r = generateRecoveryKey(counter(40));
    const text = formatRecoveryKey(r);
    expect(toHex(parseRecoveryKey(text.toLowerCase()))).toBe(toHex(r));
    const typo = text.slice(0, -1) + (text.endsWith("A") ? "B" : "A");
    expect(() => parseRecoveryKey(typo)).toThrow(expect.objectContaining({ code: "invalid_recovery_key" }));
    expect(() => parseRecoveryKey("MDB2" + text.slice(4))).toThrow(expect.objectContaining({ reason: "wrong_prefix" }));
    expect(() => parseRecoveryKey(text + "A")).toThrow(expect.objectContaining({ reason: "wrong_length" }));
  });
  it("domain hash is length-prefixed", () => {
    expect(toHex(domainHash("abc", new TextEncoder().encode("xyz")))).not.toBe(toHex(domainHash("abcx", new TextEncoder().encode("yz"))));
  });
});

describe("account key bundle (conformance/crypto/account-key)", () => {
  const v = vector("account-key");
  it("opens the shared vector and reseals it byte for byte", { timeout: 120_000 }, async () => {
    const r = fromHex(v.secret);
    const bundle = decodeBundle(fromHex(v.bundle));
    expect(toHex(bundle.keyId)).toBe(v.key_id);
    expect(toHex(keyId(r))).toBe(v.key_id);
    expect(bundle.kdf).toEqual({ mKib: v.kdf.m_kib, t: v.kdf.t, p: v.kdf.p, salt: fromHex(v.kdf.salt) });
    const opened = await openBundle(bundle, v.password, v.account);
    expect(toHex(opened)).toBe(v.secret);
    const resealed = await sealBundle(r, v.password, v.account, { kdf: bundle.kdf, nonce: fromHex(v.nonce) });
    expect(toHex(encodeBundle(resealed))).toBe(v.bundle);
  });
  it("binds the account, authenticates parameters and checks the key id", { timeout: 120_000 }, async () => {
    const r = generateRecoveryKey(counter(1));
    const b = await sealBundle(r, PASSWORD, ACCOUNT, { entropy: counter(9) });
    const bytes = encodeBundle(b);
    expect(bytes.length).toBeLessThanOrEqual(512);
    const b2 = decodeBundle(bytes);
    expect(toHex(await openBundle(b2, PASSWORD, ACCOUNT))).toBe(toHex(r));
    // NFKC: fullwidth letters of the same password open it.
    expect(toHex(await openBundle(b2, "ｃｏrrect horse battery staple", ACCOUNT))).toBe(toHex(r));
    expect(await code(openBundle(b2, "correct horse battery stapl3", ACCOUNT))).toBe("wrong_secret");
    expect(await code(openBundle(b2, PASSWORD, "08080808-0808-0808-0808-080808080808"))).toBe("wrong_secret");
    expect(() => checkRecoveryKey(r, b2)).not.toThrow();
    expect(() => checkRecoveryKey(generateRecoveryKey(counter(77)), b2)).toThrow(expect.objectContaining({ code: "wrong_secret" }));
    const weaker: Bundle = { ...b2, kdf: { ...b2.kdf, t: 2 } };
    expect(await code(openBundle(weaker, PASSWORD, ACCOUNT))).toBe("wrong_secret");
    const swapped: Bundle = { ...b2, keyId: new Uint8Array(32).fill(1) };
    expect(await code(openBundle(swapped, PASSWORD, ACCOUNT))).toBe("wrong_secret");
  });
  it("refuses hostile parameters before any work, and non-canonical bytes", async () => {
    const b = decodeBundle(fromHex(v.bundle));
    for (const [m, t, p] of [[1024, 3, 1], [19_456, 1, 1], [1 << 20, 3, 1], [19_456, 50, 1], [19_456, 3, 9]]) {
      const hostile: Bundle = { ...b, kdf: { ...b.kdf, mKib: m as number, t: t as number, p: p as number } };
      const never = async () => { throw new Error("KDF must not run"); };
      expect(await code(openBundle(hostile, PASSWORD, v.account, { argon2id: never }))).toBe("params");
      expect(() => checkKdfParams(hostile.kdf)).toThrow(expect.objectContaining({ code: "params" }));
    }
    const bytes = fromHex(v.bundle);
    expect(() => decodeBundle(new Uint8Array([...bytes, 0]))).toThrow(expect.objectContaining({ code: "encoding" }));
    expect(() => decodeBundle(new Uint8Array(513))).toThrow(expect.objectContaining({ code: "encoding" }));
    expect(() => decodeBundle(bytes.subarray(1))).toThrow(expect.objectContaining({ code: "encoding" }));
  });
  it("enforces the password length policy before the KDF", async () => {
    const never = async () => { throw new Error("KDF must not run"); };
    const r = generateRecoveryKey(counter(2));
    expect(await code(sealBundle(r, "short pass", ACCOUNT, { argon2id: never }))).toBe("weak_password");
    expect(await code(sealBundle(r, "x".repeat(1025), ACCOUNT, { argon2id: never }))).toBe("weak_password");
    expect(() => normalizePassword("short pass")).toThrow(expect.objectContaining({ reason: "too_short" }));
    expect(() => normalizePassword("x".repeat(1025))).toThrow(expect.objectContaining({ reason: "too_long" }));
    // Expansion under NFKC is bounded after normalisation too.
    expect(() => normalizePassword("ﷺ".repeat(60))).toThrow(expect.objectContaining({ reason: "too_long" }));
    expect(normalizePassword("twelve chars").length).toBe(12);
  });
  it("cancels at the runner and wipes the password copy", async () => {
    const r = generateRecoveryKey(counter(3));
    const ac = new AbortController();
    let seen: Uint8Array | null = null;
    const runner = async (pw: Uint8Array, _s: Uint8Array, _p: unknown, signal?: AbortSignal) => {
      seen = pw;
      ac.abort();
      if (signal?.aborted) throw new AccountKeyError("cancelled", "cancelled");
      return new Uint8Array(32);
    };
    expect(await code(sealBundle(r, PASSWORD, ACCOUNT, { argon2id: runner, signal: ac.signal }))).toBe("cancelled");
    expect([...(seen as unknown as Uint8Array)].every((x) => x === 0)).toBe(true);
  });
});

describe("account key proof (AK1 §5.2, Connect #635)", () => {
  it("pins the rewrap digest Connect verifies (REWRAP_VECTOR in account-keys.postgres.test.ts)", () => {
    const d = accountKeyRewrapDigest("33333333-3333-4333-8333-333333333333", new Uint8Array(100).fill(6), 3);
    expect(toHex(d)).toBe("74681c1a46f7d3aefc16a5ad665cc61da891bfcbfba11f02b713831a238f5155");
  });
  it("derives a per-account proof key from R and signs a rewrap that verifies", () => {
    const r = fromHex(vector("account-key").secret);
    const a = deriveAccountKeyProof(r, ACCOUNT);
    const b = deriveAccountKeyProof(r, "08080808-0808-0808-0808-080808080808");
    expect(toHex(a.pk)).not.toBe(toHex(b.pk));
    expect(toHex(deriveAccountKeyProof(r, ACCOUNT).pk)).toBe(toHex(a.pk));
    const bundle = new Uint8Array(100).fill(6);
    const sig = signAccountKeyRewrap(a, ACCOUNT, bundle, 3);
    expect(ed25519.verify(sig, accountKeyRewrapDigest(ACCOUNT, bundle, 3), a.pk)).toBe(true);
    expect(ed25519.verify(sig, accountKeyRewrapDigest(ACCOUNT, bundle, 4), a.pk)).toBe(false);
    expect(() => accountKeyRewrapDigest(ACCOUNT, bundle, -1)).toThrow();
  });
});
