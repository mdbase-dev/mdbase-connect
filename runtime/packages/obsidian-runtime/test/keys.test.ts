import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { formatSas, parseSas, sasEqual } from "../src/keys/sas.js";
import { formatRecoveryKey, parseRecoveryKey, RecoveryKeyError } from "../src/keys/recoveryKey.js";
import { DeviceKeyStore, type SecretStorageLike } from "../src/keys/keyStore.js";

const COL = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";

describe("SAS display (the code itself comes from the runtime)", () => {
  it("formats, parses and compares", () => {
    expect(formatSas("042917")).toBe("042 917");
    expect(() => formatSas("42917")).toThrow();
    expect(parseSas(" 042-917 ")).toBe("042917");
    expect(parseSas("04291")).toBeNull();
    expect(sasEqual("042917", "042917")).toBe(true);
    expect(sasEqual("042917", "042918")).toBe(false);
  });
});

describe("recovery key format", () => {
  it("round-trips and tolerates case, spacing and look-alikes", async () => {
    const secret = new Uint8Array(32).map((_, i) => (i * 37) & 0xff);
    const f = await formatRecoveryKey(secret);
    expect(f).toMatch(/^MDB1(-[0-9A-HJKMNP-TV-Z]{5}){11}$/);
    expect(await parseRecoveryKey(f)).toEqual(secret);
    const sloppy = f.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(await parseRecoveryKey(sloppy)).toEqual(secret);
  });
  it("rejects typos with a specific problem", async () => {
    const f = await formatRecoveryKey(new Uint8Array(32).fill(7));
    const problem = async (s: string) => {
      try {
        await parseRecoveryKey(s);
        return "none";
      } catch (e) {
        return (e as RecoveryKeyError).problem;
      }
    };
    expect(await problem(f.replace("MDB1", "MDB2"))).toBe("wrong_prefix");
    expect(await problem(f.slice(0, -1))).toBe("wrong_length");
    expect(await problem(f.slice(0, -1) + "U")).toBe("bad_character");
    const i = 12;
    const swapped = f.slice(0, i) + (f[i] === "A" ? "B" : "A") + f.slice(i + 1);
    expect(await problem(swapped)).toBe("checksum");
  });
});

class MemSecrets implements SecretStorageLike {
  m = new Map<string, string>();
  getSecret(id: string) {
    return this.m.get(id) ?? null;
  }
  setSecret(id: string, s: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("bad id");
    this.m.set(id, s);
  }
}

describe("DeviceKeyStore", () => {
  const secrets = new Uint8Array(96).map((_, i) => i);

  it("stores in IndexedDB under a non-extractable key when there is no SecretStorage", async () => {
    const ks = await DeviceKeyStore.open(`${COL}/a`);
    expect(await ks.load()).toEqual({ kind: "absent" });
    await ks.save(secrets);
    const r = await ks.load();
    expect(r).toMatchObject({ kind: "present", protection: "browser-storage" });
    expect(r.kind === "present" && r.secrets).toEqual(secrets);
    ks.close();
  });

  it("puts the ciphertext in SecretStorage when available, never the plaintext", async () => {
    const ss = new MemSecrets();
    const ks = await DeviceKeyStore.open(`${COL}/b`, { secretStorage: ss });
    await ks.save(secrets);
    const [stored] = [...ss.m.values()];
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(Buffer.from(secrets).toString("base64"));
    expect(await ks.load()).toMatchObject({ kind: "present", protection: "keychain" });
    ks.close();
  });

  it("reports a lost identity when browser storage was cleared but the keychain entry remains", async () => {
    const ss = new MemSecrets();
    const ks = await DeviceKeyStore.open(`${COL}/c`, { secretStorage: ss });
    await ks.save(secrets);
    await ks.erase(); // simulate: IDB gone ...
    ss.setSecret([...ss.m.keys()][0]!, "v1.AAAA.BBBB"); // ... keychain entry left behind
    expect(await ks.load()).toEqual({ kind: "lost", reason: "kek_missing" });
    ks.close();
  });

  it("reports a lost identity when the keychain entry is gone", async () => {
    const ss = new MemSecrets();
    const ks = await DeviceKeyStore.open(`${COL}/d`, { secretStorage: ss });
    await ks.save(secrets);
    ss.m.clear();
    expect(await ks.load()).toEqual({ kind: "lost", reason: "ciphertext_missing" });
    ks.close();
  });

  it("binds the ciphertext to its namespace", async () => {
    const ss = new MemSecrets();
    const a = await DeviceKeyStore.open(`${COL}/e`, { secretStorage: ss });
    const b = await DeviceKeyStore.open(`${COL}/f`, { secretStorage: ss });
    await a.save(secrets);
    await b.save(new Uint8Array(96).fill(1));
    const [ia, ib] = [...ss.m.keys()];
    const va = ss.m.get(ia!)!;
    ss.m.set(ia!, ss.m.get(ib!)!);
    ss.m.set(ib!, va);
    expect(await a.load()).toEqual({ kind: "lost", reason: "decrypt_failed" });
    a.close();
    b.close();
  });
});
