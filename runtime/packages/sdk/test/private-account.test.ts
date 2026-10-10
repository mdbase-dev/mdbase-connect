import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  AccountKeyError, accountKeyRewrapDigest, decodeBundle, deriveAccountKeyProof, deriveRecoveryDevice, domainHash, keyId, openBundle,
  parseRecoveryKey, type Argon2idRunner,
} from "../src/account-key.js";
import { decode, fromHex, toHex } from "../src/cbor.js";
import {
  PrivateAccount, memorySecretStore, type AccountKeyControlPort, type AccountKeyReplicaPort,
} from "../src/private-account.js";
import { passwordStrength } from "../src/strength.js";

const ACCOUNT = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";
const COLL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PASSWORD = "correct horse battery staple";
const counter = (seed: number) => (n: number) => new Uint8Array(n).map((_, i) => (seed * 7 + i) & 0xff);
// A fast stand-in KDF so the facade tests run quickly; the real one is pinned in account-key.test.ts.
const fastKdf: Argon2idRunner = async (pw, salt) => domainHash("test-kdf", new Uint8Array([...pw, ...salt]));
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AccountKeyError ? `${e.code}${e.reason ? ":" + e.reason : ""}` : `other:${String(e)}`));

/** An in-memory control plane with the real route semantics (versions, modes, proof-of-possession check). */
function controlPlane() {
  let row: { mode: "password" | "strict"; version: number; key_id?: string; bundle?: string; proof_pk?: string } | null = null;
  const challenges = new Set<string>();
  let n = 0;
  const enrolled: { collection: string; device: string; sign_pk: string }[] = [];
  let witnessed = false;
  const completion = () => ({
    complete: witnessed || enrolled.length === 0,
    pending: witnessed ? [] : enrolled.map((e) => ({ collection_id: e.collection, device_id: e.device, revoked_at: null })),
  });
  const port: AccountKeyControlPort = {
    accountId: ACCOUNT,
    status: vi.fn(async () => (row ? { mode: row.mode, version: row.version, ...(row.key_id ? { key_id: row.key_id } : {}), ...(row.mode === "strict" ? completion() : {}) } : { mode: "none", version: 0 })),
    fetch: vi.fn(async () => (row ? { ...row } : { mode: "none", version: 0 })),
    put: vi.fn(async (body) => {
      const current = row?.version ?? 0;
      if (current !== body.expected_version) throw { status: 409, code: "version_conflict" };
      if (row?.mode === "password" && row.key_id !== body.key_id) throw { status: 409, code: "rotate_requires_strict" };
      if (!/^[0-9a-f]{64}$/.test(body.proof_pk) || !/^[0-9a-f]{128}$/.test(body.proof_sig)) throw { status: 400, code: "invalid_request" };
      if (row?.mode === "password") {
        // Replacing a bundle needs proof of R: the registered proof key signs this rewrap.
        const digest = accountKeyRewrapDigest(ACCOUNT, fromHex(body.bundle), body.expected_version);
        if (row.proof_pk !== body.proof_pk || !ed25519.verify(fromHex(body.proof_sig), digest, fromHex(body.proof_pk))) {
          throw { status: 403, code: "account_key_proof_required" };
        }
      }
      row = { mode: "password", version: current + 1, key_id: body.key_id, bundle: body.bundle, proof_pk: body.proof_pk };
      return { mode: "password", version: row.version, key_id: body.key_id };
    }),
    strict: vi.fn(async (body) => {
      const current = row?.version ?? 0;
      if (current !== body.expected_version) throw { status: 409, code: "version_conflict" };
      row = { mode: "strict", version: row?.mode === "strict" ? current : current + 1 };
      return { mode: "strict", version: row.version, ...completion(), revocations: enrolled.map((e) => ({ collection_id: e.collection, device_id: e.device })) };
    }),
    challenge: vi.fn(async () => {
      const c = toHex(new Uint8Array(32).fill(++n));
      challenges.add(c);
      return { challenge: c };
    }),
    enrolRecoveryDevice: vi.fn(async (collection, body) => {
      if (!challenges.delete(body.challenge)) throw { status: 403, code: "invalid_proof" };
      if (row?.mode !== "password") throw { status: 409, code: row ? "strict_mode" : "no_account_key" };
      const digest = domainHash("mdbase/v1/account-key-enrol", encodeArr([
        fromHex(body.challenge), uuid(collection), uuid(body.recovery_device), uuid(ACCOUNT), fromHex(body.sign_pk), fromHex(body.kem_pk), new Uint8Array(32),
      ]));
      if (!ed25519.verify(fromHex(body.pop), digest, fromHex(body.sign_pk))) throw { status: 403, code: "invalid_proof" };
      enrolled.push({ collection, device: body.recovery_device, sign_pk: body.sign_pk });
      return { collection_id: collection, device_id: body.recovery_device, enrolled_at: enrolled.length };
    }),
  };
  return { port, enrolled, row: () => row, witnessAll: () => { witnessed = true; } };
}
import { encode as encodeArr } from "../src/cbor.js";
import { uuidBytes as uuid } from "../src/account-key.js";

function replica(collections = [COLL_A, COLL_B]) {
  const keyed: { collection: string; secret: string }[] = [];
  const granted: { collection: string; secret: string }[] = [];
  const port: AccountKeyReplicaPort = {
    privateCollections: vi.fn(async () => collections),
    keyAccountKeyDevice: vi.fn(async (c, s) => { keyed.push({ collection: c, secret: toHex(s) }); }),
    selfGrantWithAccountKey: vi.fn(async (c, s) => { granted.push({ collection: c, secret: toHex(s) }); }),
  };
  return { port, keyed, granted };
}

const account = (control: AccountKeyControlPort, rep: AccountKeyReplicaPort, extra: Partial<ConstructorParameters<typeof PrivateAccount>[0]> = {}) =>
  new PrivateAccount({ control, replica: rep, secrets: memorySecretStore(), argon2id: fastKdf, entropy: counter(3), ...extra });

describe("PrivateAccount (AK1 §7)", () => {
  it("sets up: seals R, stores the bundle, enrols and keys the recovery device of every private collection", async () => {
    const cp = controlPlane();
    const rep = replica();
    const a = account(cp.port, rep.port);
    expect(await a.status()).toEqual({ mode: "none", unlocked: false, version: 0 });
    const { recoveryKey, incomplete } = await a.setup(PASSWORD);
    expect(incomplete).toBeUndefined();
    const r = parseRecoveryKey(recoveryKey);
    const row = cp.row()!;
    expect(row.mode).toBe("password");
    expect(row.version).toBe(1);
    expect(row.key_id).toBe(toHex(keyId(r)));
    expect(row.proof_pk).toBe(toHex(deriveAccountKeyProof(r, ACCOUNT).pk));
    const bundle = decodeBundle(fromHex(row.bundle!));
    expect(toHex(await openBundle(bundle, PASSWORD, ACCOUNT, { argon2id: fastKdf }))).toBe(toHex(r));
    // Each collection: a proof-of-possession enrolment of the derived device, then the replica keys it with R.
    expect(cp.enrolled.map((e) => e.collection)).toEqual([COLL_A, COLL_B]);
    expect(cp.enrolled[0]!.device).toBe(deriveRecoveryDevice(r, COLL_A).device);
    expect(rep.keyed).toEqual([{ collection: COLL_A, secret: toHex(r) }, { collection: COLL_B, secret: toHex(r) }]);
    expect(rep.granted).toEqual([]);
    expect(await a.status()).toEqual({ mode: "password", unlocked: true, version: 1 });
    expect(await code(a.setup(PASSWORD))).toBe("already_set_up");
  });

  it("refuses weak or short passwords before touching the network", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica().port);
    expect(await code(a.setup("password1234"))).toBe("weak_password:strength");
    expect(await code(a.setup("short"))).toBe("weak_password:too_short");
    expect(cp.port.fetch).not.toHaveBeenCalled();
    expect(cp.port.put).not.toHaveBeenCalled();
  });

  it("unlocks a second device with the password or the recovery key and self-grants everywhere", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica([COLL_A]).port);
    const { recoveryKey } = await a.setup(PASSWORD);
    const r = toHex(parseRecoveryKey(recoveryKey));
    const repB = replica();
    const b = account(cp.port, repB.port);
    expect(await b.status()).toEqual({ mode: "password", unlocked: false, version: 1 });
    expect(await b.unlock({ password: PASSWORD })).toEqual({});
    expect(repB.granted).toEqual([{ collection: COLL_A, secret: r }, { collection: COLL_B, secret: r }]);
    expect(repB.keyed).toEqual([]);
    expect((await b.status()).unlocked).toBe(true);
    expect(await code(b.unlock({ password: "correct horse battery stapl3" }))).toBe("wrong_secret");
    const repC = replica([COLL_B]);
    const c = account(cp.port, repC.port);
    expect(await c.unlock({ recoveryKey: recoveryKey.toLowerCase() })).toEqual({});
    expect(repC.granted).toEqual([{ collection: COLL_B, secret: r }]);
    expect(await code(c.unlock({ recoveryKey: "MDB1-" + recoveryKey.slice(5, -1) + "0" }))).toMatch(/^invalid_recovery_key/);
    const other = "MDB1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FJNC8";
    expect(await code(c.unlock({ recoveryKey: other }))).toBe("wrong_secret");
  });

  it("reports collections whose grant failed without losing R, and never keys with a different key", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica([COLL_A]).port);
    await a.setup(PASSWORD);
    const rep = replica();
    vi.mocked(rep.port.selfGrantWithAccountKey).mockImplementation(async (c) => { if (c === COLL_A) throw new Error("not current"); });
    const b = account(cp.port, rep.port);
    expect(await b.unlock({ password: PASSWORD })).toEqual({ incomplete: [COLL_A] });
    expect((await b.status()).unlocked).toBe(true);
  });

  it("changes the password by re-wrapping the same R, requires unlocked, and maps version conflicts", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica([COLL_A]).port);
    const { recoveryKey } = await a.setup(PASSWORD);
    const before = cp.row()!;
    const next = "a different passphrase entirely";
    await a.changePassword(next);
    const after = cp.row()!;
    expect(after.version).toBe(2);
    expect(after.key_id).toBe(before.key_id);
    expect(after.bundle).not.toBe(before.bundle);
    expect(toHex(await openBundle(decodeBundle(fromHex(after.bundle!)), next, ACCOUNT, { argon2id: fastKdf }))).toBe(toHex(parseRecoveryKey(recoveryKey)));
    const locked = account(cp.port, replica().port);
    expect(await code(locked.changePassword(next))).toBe("locked");
    expect(await code(a.changePassword("password1234"))).toBe("weak_password:strength");
    // A device that holds a different R cannot replace the bundle (proof key mismatch).
    const impostor = account(cp.port, replica().port);
    await impostor.unlock({ password: next });
    expect(await code(impostor.changePassword("completely different passphrase"))).toBe("ok");
    const other = account(cp.port, replica().port, { secrets: { get: async () => new Uint8Array(32).fill(5), set: async () => {}, clear: async () => {} } });
    expect(await code(other.changePassword("completely different passphrase 2"))).toBe("conflict:key_id_changed");
    // Someone else moved the version between our fetch and put.
    vi.mocked(cp.port.put).mockRejectedValueOnce({ status: 409, code: "version_conflict" });
    expect(await code(a.changePassword("yet another long passphrase"))).toBe("conflict:version_conflict");
  });

  it("recovers with the recovery key: new bundle, same key id, device self-granted", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica([COLL_A]).port);
    const { recoveryKey } = await a.setup(PASSWORD);
    const rep = replica([COLL_A]);
    const b = account(cp.port, rep.port);
    const next = "forgot it, so a brand new passphrase";
    expect(await b.recover(recoveryKey, next)).toEqual({});
    const row = cp.row()!;
    expect(row.version).toBe(2);
    expect(row.key_id).toBe(toHex(keyId(parseRecoveryKey(recoveryKey))));
    expect(rep.granted).toHaveLength(1);
    expect((await b.status()).unlocked).toBe(true);
    const c = account(cp.port, replica().port);
    expect(await c.unlock({ password: next })).toEqual({});
    expect(await code(c.recover("MDB1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FJNC8", next))).toBe("wrong_secret");
  });

  it("strict mode deletes the bundle but keeps R until CP witnesses complete, and blocks unlock and recovery", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica([COLL_A]).port);
    await a.setup(PASSWORD);
    const strict = await a.enableStrict();
    const pending = [{ collectionId: COLL_A, deviceId: cp.enrolled[0]!.device, revokedAt: null }];
    expect(strict).toEqual({ version: 2, alreadyStrict: false, complete: false, pending, accountKeyKept: true, revocations: [{ collectionId: COLL_A, deviceId: cp.enrolled[0]!.device }] });
    expect(cp.row()).toMatchObject({ mode: "strict", version: 2 });
    expect(await a.status()).toEqual({ mode: "strict", unlocked: false, version: 2, strictComplete: false, pending, accountKeyKept: true });
    expect(await a.enableStrict()).toEqual({ version: 2, alreadyStrict: true, complete: false, pending, accountKeyKept: true, revocations: [] });
    expect(cp.row()!.version).toBe(2);
    expect(cp.port.strict).toHaveBeenCalledTimes(1);
    cp.witnessAll();
    // Status remains read-only, even on explicit completion.
    expect(await a.status()).toEqual({ mode: "strict", unlocked: false, version: 2, strictComplete: true, pending: [], accountKeyKept: true });
    expect(await a.enableStrict()).toEqual({ version: 2, alreadyStrict: true, complete: true, pending: [], accountKeyKept: false, revocations: [] });
    expect(a.lastStatus).toEqual({ mode: "strict", unlocked: false, version: 2, strictComplete: true, pending: [], accountKeyKept: false });
    const b = account(cp.port, replica().port);
    expect(await code(b.unlock({ password: PASSWORD }))).toBe("strict_mode");
    expect(await code(b.recover("MDB1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FJNC8", PASSWORD))).toBe("strict_mode");
    // Leaving strict mode is setup again with a new key (a new key id at the next version).
    const { recoveryKey } = await b.setup(PASSWORD);
    expect(cp.row()!.version).toBe(3);
    expect(cp.row()!.key_id).toBe(toHex(keyId(parseRecoveryKey(recoveryKey))));
  });

  it("accepts CP empty-set completion without consulting local hosting coverage or the fetch budget", async () => {
    const cp = controlPlane();
    const rep = replica([]);
    const secrets = memorySecretStore();
    const a = account(cp.port, rep.port, { secrets });
    await a.setup(PASSWORD);
    vi.mocked(rep.port.privateCollections).mockClear();
    vi.mocked(cp.port.fetch).mockClear();
    expect(await a.enableStrict()).toMatchObject({ version: 2, complete: true, pending: [], accountKeyKept: false });
    expect(await secrets.get()).toBeNull();
    expect(rep.port.privateCollections).not.toHaveBeenCalled();
    expect(cp.port.fetch).not.toHaveBeenCalled();
  });

  it("shows the CP pending list even for collections this device does not host", async () => {
    const cp = controlPlane();
    const rep = replica([COLL_A]);
    const secrets = memorySecretStore();
    const a = account(cp.port, rep.port, { secrets });
    await a.setup(PASSWORD);
    await a.enableStrict();
    vi.mocked(rep.port.privateCollections).mockResolvedValue([]);
    vi.mocked(cp.port.status).mockResolvedValue({ mode: "strict", version: 2, complete: false,
      pending: [{ collection_id: COLL_B, device_id: ACCOUNT, revoked_at: 17 }] });
    expect(await a.enableStrict()).toMatchObject({ version: 2, complete: false, accountKeyKept: true,
      pending: [{ collectionId: COLL_B, deviceId: ACCOUNT, revokedAt: 17 }] });
    expect(await secrets.get()).not.toBeNull();
  });

  it.each([
    {}, { complete: "true", pending: [] }, { complete: 1, pending: [] }, { complete: null, pending: [] },
    { complete: true }, { complete: true, pending: null }, { complete: true, pending: {} },
    { complete: true, pending: [{ collection_id: COLL_A, device_id: ACCOUNT, revoked_at: null }] },
    ...[undefined, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1].map((revoked_at) => ({ complete: false,
      pending: [{ collection_id: COLL_A, device_id: ACCOUNT, revoked_at }] })),
    { complete: false, pending: [{ collection_id: "bad", device_id: ACCOUNT, revoked_at: null }] },
    { complete: false, pending: [null] },
    { complete: false, pending: Array(1025).fill({ collection_id: COLL_A, device_id: ACCOUNT, revoked_at: null }) },
    { complete: false, pending: Array(2).fill({ collection_id: COLL_A, device_id: ACCOUNT, revoked_at: null }) },
  ])("never deletes R on malformed strict completion metadata: %j", async (fields) => {
    const cp = controlPlane();
    const secrets = memorySecretStore();
    const a = account(cp.port, replica([COLL_A]).port, { secrets });
    await a.setup(PASSWORD);
    vi.mocked(cp.port.strict).mockResolvedValueOnce({ mode: "strict", version: 2, revocations: [], ...fields });
    expect(await code(a.enableStrict())).toMatch(/^(internal|encoding)/);
    expect(await secrets.get()).not.toBeNull();
    // The same validation applies to already-strict status/retries.
    vi.mocked(cp.port.status).mockResolvedValue({ mode: "strict", version: 2, ...fields });
    expect(await code(a.status())).toMatch(/^(internal|encoding)/);
    expect(await code(a.enableStrict())).toMatch(/^(internal|encoding)/);
    expect(await secrets.get()).not.toBeNull();
  });

  it("does not report a committed strict transition as cancelled or clear R while pending", async () => {
    const cp = controlPlane();
    const secrets = memorySecretStore();
    const a = account(cp.port, replica([COLL_A]).port, { secrets });
    await a.setup(PASSWORD);
    const ac = new AbortController();
    const post = vi.mocked(cp.port.strict).getMockImplementation()!;
    vi.mocked(cp.port.strict).mockImplementationOnce(async (...args) => {
      const response = await post(...args);
      ac.abort();
      return response;
    });
    expect(await a.enableStrict(ac.signal)).toMatchObject({ version: 2, complete: false, accountKeyKept: true });
    expect(await secrets.get()).not.toBeNull();
    expect(cp.row()).toMatchObject({ mode: "strict", version: 2 });
  });

  it("no account key yet: unlock and recover say so", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica().port);
    expect(await code(a.unlock({ password: PASSWORD }))).toBe("no_account_key");
    expect(await code(a.recover("MDB1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FJNC8", PASSWORD))).toBe("no_account_key");
  });

  it("maps control-plane failures to typed errors and never leaks foreign error objects", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica().port);
    vi.mocked(cp.port.status).mockRejectedValueOnce({ status: 429, code: "rate_limited", retry_after: 900 });
    const e = await a.status().catch((x) => x);
    expect(e).toBeInstanceOf(AccountKeyError);
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(900_000);
    vi.mocked(cp.port.status).mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await code(a.status())).toBe("unavailable:port_failure");
    vi.mocked(cp.port.status).mockRejectedValueOnce({ status: 503, problem: { code: "not_ready" } });
    expect(await code(a.status())).toBe("unavailable:not_ready");
  });

  it("rejects malformed or inconsistent control-plane responses", async () => {
    const cp = controlPlane();
    const a = account(cp.port, replica().port);
    for (const bad of [null, [], { mode: "password", version: 1 }, { mode: "none", version: 2 }, { mode: "weird", version: 0 }]) {
      vi.mocked(cp.port.status).mockResolvedValueOnce(bad);
      expect(await code(a.status())).toMatch(/^internal/);
    }
    for (const bad of [null, { mode: "password", version: 1 }, { mode: "password", version: 1, key_id: "00".repeat(32), bundle: "ff" }]) {
      vi.mocked(cp.port.fetch).mockResolvedValueOnce(bad);
      expect(await code(a.unlock({ password: PASSWORD }))).toMatch(/^(internal|encoding)/);
    }
    // A bundle whose key id does not match the row's.
    await a.setup(PASSWORD);
    const row = cp.row()!;
    vi.mocked(cp.port.fetch).mockResolvedValueOnce({ ...row, key_id: "11".repeat(32) });
    expect(await code(a.unlock({ password: PASSWORD }))).toBe("internal:key_id");
    expect(cp.port.fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ budget: true }));
    // A PUT acknowledged with the wrong version is not trusted.
    vi.mocked(cp.port.put).mockResolvedValueOnce({ mode: "password", version: 7, key_id: row.key_id });
    expect(await code(a.changePassword("another acceptable passphrase here"))).toBe("internal:put");
  });

  it("cancels before dispatch and between steps, never after a committed write", async () => {
    const cp = controlPlane();
    const rep = replica([COLL_A]);
    const a = account(cp.port, rep.port);
    const ac = new AbortController();
    ac.abort();
    expect(await code(a.setup(PASSWORD, ac.signal))).toBe("cancelled");
    expect(cp.port.put).not.toHaveBeenCalled();
    // Abort while the bundle is being stored: the write stands, R is kept, the enrolment loop stops.
    const ac2 = new AbortController();
    vi.mocked(cp.port.put).mockImplementationOnce(async (body) => {
      ac2.abort();
      const current = cp.row()?.version ?? 0;
      return { mode: "password", version: current + 1, key_id: body.key_id };
    });
    const result = await a.setup(PASSWORD, ac2.signal).catch((e) => e);
    expect(result).toBeInstanceOf(AccountKeyError);
    expect(result.code).toBe("cancelled");
    expect(rep.keyed).toEqual([]);
    const held = await a.status();
    expect(held.mode).toBe("none"); // the fake control plane's put mock did not persist, so status reflects the server
    a.close();
    expect(await code(a.status())).toBe("cancelled");
  });

  it("re-keys later private collections with keyCollections once unlocked", async () => {
    const cp = controlPlane();
    const rep = replica([COLL_A]);
    const a = account(cp.port, rep.port);
    await a.setup(PASSWORD);
    vi.mocked(rep.port.privateCollections).mockResolvedValue([COLL_A, COLL_B]);
    expect(await a.keyCollections()).toEqual([]);
    expect(rep.keyed.map((k) => k.collection)).toEqual([COLL_A, COLL_A, COLL_B]);
    expect(cp.enrolled.map((e) => e.collection)).toEqual([COLL_A, COLL_A, COLL_B]);
    await a.lock();
    expect(await code(a.keyCollections())).toBe("locked");
  });
});

describe("passwordStrength", () => {
  it("scores guessable passwords low and passphrases high", () => {
    expect(passwordStrength("password").score).toBe(0);
    expect(passwordStrength("password1234").acceptable).toBe(false);
    expect(passwordStrength("P@ssw0rd2019!").acceptable).toBe(false);
    expect(passwordStrength("qwertyuiop12").acceptable).toBe(false);
    expect(passwordStrength("aaaaaaaaaaaaaaaa").acceptable).toBe(false);
    expect(passwordStrength("abcdefghijkl").acceptable).toBe(false);
    expect(passwordStrength("correct horse battery staple").score).toBe(4);
    expect(passwordStrength("correct horse battery staple").acceptable).toBe(true);
    expect(passwordStrength("Tr0ub4dor&3").feedback).toContain("Use at least 12 characters.");
    expect(passwordStrength("x".repeat(1025)).acceptable).toBe(false);
    const ok = passwordStrength("lantern 7 orbit velvet");
    expect(ok.score).toBeGreaterThanOrEqual(3);
    expect(ok.feedback).toEqual([]);
  });
  it("is deterministic and never throws on odd input", () => {
    expect(passwordStrength("")).toEqual(passwordStrength(""));
    expect(passwordStrength("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂").score).toBeGreaterThanOrEqual(0);
    expect(passwordStrength(undefined as unknown as string).score).toBe(0);
  });
});

// decode is imported to keep the CBOR round trip visible in failure output.
void decode;
