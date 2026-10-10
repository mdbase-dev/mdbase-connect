/**
 * LAB-only pieces (env.LAB === "1", the separate mdbase-lab account). Never active
 * in production builds: the production custody is KMS (hosted workstream).
 *
 * - `labAuthorized`: the admin surface requires `Authorization: Bearer
 *   <LAB_ADMIN_TOKEN>` (constant-time compare).
 * - `labCustody`: service device keys from the `LAB_HOSTED_CONFIG` secret (JSON
 *   with hex keys). The log token is `LAB_LOG_TOKEN` if set, else minted here with
 *   `LAB_TOKEN_ISSUER_SEED` — a LAB-only stand-in for the control plane's issuer,
 *   trusted only by the LAB e2e log Worker. Copies are wiped by `zeroize`; the
 *   parsed secret is not cached.
 */
import { encode, type CborValue } from "../../../packages/sdk/src/cbor.js";
import type { Custody, OpenKeys } from "./seams.js";
import { deploymentRelease, type FactoryEnv } from "./factory.ts";
import type { VerifyOriginalGenesis } from "./custody/hosted-custody.ts";

function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error("hex");
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
}

function equal(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export function labAuthorized(env: Env, request: Request): boolean {
  const want = (env as unknown as { LAB_ADMIN_TOKEN?: string }).LAB_ADMIN_TOKEN;
  const got = request.headers.get("authorization") ?? "";
  return !!want && want.length >= 32 && equal(got, `Bearer ${want}`);
}

interface LabConfig {
  device: string;
  replica: string;
  sign_sk: string;
  sign_pk: string;
  kem_sk: string;
  /** App mode: the hosted device's Noise static secret. */
  noise_sk?: string;
  roots: string[];
  signers: string[];
  collections: string[];
  /** Public originals per fixture collection; not an unsigned pins override. */
  genesis: Record<string, { item: string; hash: string }>;
}

export function labCustody(
  env: Env,
  derive: ((secret: Uint8Array) => { signPk: Uint8Array; kemPk: Uint8Array; noisePk: Uint8Array } | null) | undefined,
  verifyOriginal: VerifyOriginalGenesis,
): Custody {
  const secret = () => {
    const raw = (env as unknown as { LAB_HOSTED_CONFIG?: string }).LAB_HOSTED_CONFIG;
    if (!raw) throw new Error("custody_unavailable");
    return JSON.parse(raw) as LabConfig;
  };
  const origin = (c: LabConfig, collection: string) => {
    const release = deploymentRelease(env as unknown as FactoryEnv);
    const g = c.genesis?.[collection];
    if (!release || !g || typeof g.item !== "string" || !g.item.length || g.item.length > 4 * Math.ceil((64 << 10) / 3)
        || typeof g.hash !== "string" || !/^[0-9a-f]{64}$/.test(g.hash)) throw new Error("custody_unavailable");
    const binary = atob(g.item);
    if (btoa(binary) !== g.item) throw new Error("custody_unavailable");
    const item = Uint8Array.from(binary, c => c.charCodeAt(0)), hash = fromHex(g.hash);
    if (!verifyOriginal(collection, release.policyPins, item, hash)) throw new Error("custody_unavailable");
    return { release, item, hash };
  };
  return {
    async openSealer(collection: string): Promise<OpenKeys> {
      const c = secret();
      if (!c.collections.includes(collection)) throw new Error("custody_unavailable");
      const original = origin(c, collection); // BEFORE decoding/deriving any fixture key.
      const noiseSk = c.noise_sk ? fromHex(c.noise_sk) : undefined;
      let publicKeys;
      if (noiseSk && derive) {
        const all = new Uint8Array(96);
        all.set(fromHex(c.sign_sk), 0);
        all.set(fromHex(c.kem_sk), 32);
        all.set(noiseSk, 64);
        publicKeys = derive(all) ?? undefined;
        all.fill(0);
      }
      const keys: OpenKeys = {
        deviceId: c.device,
        replicaId: c.replica,
        signSk: fromHex(c.sign_sk),
        kemSk: fromHex(c.kem_sk),
        ...(noiseSk && publicKeys ? { noiseSk, publicKeys } : {}),
        roots: original.release.trustedRoots.map(pk => new Uint8Array(pk)),
        signers: c.signers,
        policyPins: new Uint8Array(original.release.policyPins), originalGenesis: original.item, genesisSha256: original.hash,
        zeroize() {
          keys.signSk.fill(0);
          keys.kemSk.fill(0);
          noiseSk?.fill(0);
        },
      };
      if (keys.signSk.length !== 32 || keys.kemSk.length !== 32) {
        keys.zeroize();
        throw new Error("custody_unavailable");
      }
      return keys;
    },
    async logToken(collection: string): Promise<string> {
      const e = env as unknown as { LAB_LOG_TOKEN?: string; LAB_TOKEN_ISSUER_SEED?: string };
      const c = secret();
      if (!c.collections.includes(collection)) throw new Error("custody_unavailable");
      origin(c, collection);
      if (e.LAB_LOG_TOKEN) return e.LAB_LOG_TOKEN;
      if (!e.LAB_TOKEN_ISSUER_SEED) throw new Error("custody_unavailable");
      return mintDeviceToken(fromHex(e.LAB_TOKEN_ISSUER_SEED), c.device, fromHex(c.sign_pk), collection);
    },
  };
}

const uuidBytes = (u: string) => fromHex(u.replace(/-/g, ""));

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}

/** logsvc evaluation token: hex(claims) "." hex(Ed25519(issuer, H("mdbase/v1/ls-token", claims))). */
async function mintDeviceToken(seed: Uint8Array, device: string, signPk: Uint8Array, collection: string): Promise<string> {
  const claims = encode(new Map<number, CborValue>([
    [0, 0],
    [1, uuidBytes(device)],
    [2, signPk],
    [3, Date.now() + 10 * 60_000],
    [4, "mdbase-log"],
    [5, uuidBytes(collection)],
  ]));
  const tag = new TextEncoder().encode("mdbase/v1/ls-token");
  const pre = new Uint8Array(1 + tag.length + claims.length);
  pre[0] = tag.length;
  pre.set(tag, 1);
  pre.set(claims, 1 + tag.length);
  const digest = await sha256(pre);
  const pkcs8 = new Uint8Array([...fromHex("302e020100300506032b657004220420"), ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, digest));
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex(claims)}.${hex(sig)}`;
}
