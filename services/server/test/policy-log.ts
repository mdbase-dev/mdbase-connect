// Shared synthetic log TRANSPORT for real signed PolicyEmitter/PG tests.
import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { expect } from "vitest";
import { certDigest, chainHash, decodeCbor, domainHash, encodeCbor, keyId, policyItemSignedDigest, type Cbor, type Decoded, type PolicySigner } from "../src/features/next/policy-wire.js";
import { ed25519PublicKeyObject, ed25519RawPublicKey } from "../src/features/next/policy-keys.js";

export function certify(root: KeyObject, policy: KeyObject, now: number): PolicySigner {
  const unsigned = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: now - 60_000, notAfter: now + 90 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  return { cert: { ...unsigned, signature: sign(null, certDigest(unsigned), root) }, privateKey: policy };
}

export const field = (value: Decoded | undefined, key: number) => (value instanceof Map ? value.get(key) : undefined);
export const bytes = (value: Decoded | undefined) => Buffer.from(value as Uint8Array);

/**
 * A log service holding the contract's append rules (log-service-api.md §4.1: idempotent
 * replay, conditional head, policy signatures) and checking the client's token and
 * proof of possession. `dropNextResponse` commits but loses the response.
 */
export class FakeLogService {
  readonly logs = new Map<string, Buffer[]>();
  dropNextResponse: boolean | "append" = false;
  beforeAppend?: () => Promise<void>;
  refuseNextAppend = false;
  failNextRead = false;
  failNextAppend = false;
  failReadCollection: string | undefined;
  /** The region recorded for the next log created; each log answers its own on every create_log. */
  region: string | undefined;
  readonly regions = new Map<string, string>();
  constructor(private readonly issuer: Uint8Array) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/nonce") return new Response("ab".repeat(32));
    const body = Buffer.from(init!.body as Uint8Array);
    const headers = new Headers(init!.headers);
    const token = headers.get("authorization")!.replace("Bearer ", "");
    const [claimsHex, sigHex] = token.split(".");
    const claims = Buffer.from(claimsHex!, "hex");
    expect(verify(null, domainHash("mdbase/v1/ls-token", claims), ed25519PublicKeyObject(this.issuer), Buffer.from(sigHex!, "hex"))).toBe(true);
    const frame = decodeCbor(body);
    const method = field(frame, 2) as string;
    const params = field(frame, 3);
    const collectionBytes = bytes(field(params, 0));
    const possession = domainHash("mdbase/v1/ls-http", Buffer.concat([
      Buffer.from(method), Buffer.of(0), Buffer.from(url.pathname), Buffer.of(0), collectionBytes,
      createHash("sha256").update(token, "utf8").digest(), createHash("sha256").update(body).digest(),
      Buffer.from(headers.get("x-mdbase-nonce")!, "hex"),
    ]));
    expect(verify(null, possession, ed25519PublicKeyObject(bytes(field(decodeCbor(claims), 2))), Buffer.from(headers.get("x-mdbase-sig")!, "hex"))).toBe(true);
    const collection = collectionBytes.toString("hex");
    const log = this.logs.get(collection);
    const head = () => ({ seq: log?.length ?? 0, chain: log?.length ? chainHash(log[log.length - 1]!) : new Uint8Array(32) });
    const st = (...fields: Array<readonly [number, Cbor]>): Cbor => ({ struct: fields });
    let result: Cbor;
    if (method === "create_log") {
      const genesis = bytes(field(params, 1));
      if (log && !log[0]!.equals(genesis)) return this.reply({ error: "invalid" });
      if (!log) {
        this.logs.set(collection, [genesis]);
        if (this.region) this.regions.set(collection, this.region);
      }
      const region = this.regions.get(collection);
      result = region ? st([0, 1], [1, chainHash(genesis)], [2, region]) : st([0, 1], [1, chainHash(genesis)]);
    } else if (method === "head") {
      if (!log) return this.reply({ error: "not_found" });
      result = st([0, head().seq], [1, head().chain], [2, 1]);
    } else if (method === "read") {
      if (this.failNextRead && (!this.failReadCollection || this.failReadCollection === collection)) {
        this.failNextRead = false;
        throw new TypeError("read failed");
      }
      if (!log) return this.reply({ error: "not_found" });
      const after = field(params, 1) as number;
      const items: Cbor[] = [];
      for (let i = after; i < log.length; i += 1) {
        const decoded = decodeCbor(log[i]!);
        if (field(decoded, 0) !== 1) continue;
        items.push([i + 1, log[i]!]);
        break;
      }
      result = st([0, items], [1, head().seq], [2, head().chain], [3, 1], [4, false], [6, false]);
    } else if (method === "append") {
      await this.beforeAppend?.();
      if (this.failNextAppend) {
        this.failNextAppend = false;
        throw new TypeError("append unavailable");
      }
      if (this.refuseNextAppend) {
        this.refuseNextAppend = false;
        return this.reply({ error: "forbidden" });
      }
      if (!log) return this.reply({ error: "not_found" });
      const expectSeq = field(params, 1) as number;
      const items = (field(params, 3) as Uint8Array[]).map((item) => Buffer.from(item));
      if (expectSeq <= log.length && items.every((item, i) => log[expectSeq - 1 + i]?.equals(item))) {
        result = st([0, 0], [1, expectSeq], [2, expectSeq + items.length - 1]);
      } else if (expectSeq !== log.length + 1 || !bytes(field(params, 2)).equals(Buffer.from(head().chain))) {
        result = st([0, 1], [1, head().seq], [2, head().chain]);
      } else {
        log.push(...items);
        result = st([0, 0], [1, expectSeq], [2, log.length]);
      }
    } else {
      return this.reply({ error: "invalid" });
    }
    if (this.dropNextResponse && (this.dropNextResponse === true || method === "append")) {
      this.dropNextResponse = false;
      throw new TypeError("fetch failed");
    }
    return this.reply({ result });
  };

  private reply(input: { result?: Cbor; error?: string }): Response {
    const frame = encodeCbor({ struct: [[0, 1], [1, 1], [2, input.result], [3, input.error ? { struct: [[0, input.error]] } : undefined]] });
    return new Response(new Uint8Array(frame), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  }

  /** Decode the policy ops at each position, verifying each item's signature. */
  policyOps(collectionId: string, policyKey: Uint8Array): string[][] {
    return this.logs.get(collectionId.replaceAll("-", ""))!.map((item) => {
      const decoded = decodeCbor(item);
      expect(bytes(field(decoded, 6)).equals(Buffer.from(keyId(policyKey)))).toBe(true);
      const digest = policyItemSignedDigest(collectionId, field(decoded, 3) as number, bytes(field(decoded, 4)), bytes(field(decoded, 6)), bytes(field(decoded, 11)));
      expect(verify(null, digest, ed25519PublicKeyObject(policyKey), bytes(field(decoded, 12)))).toBe(true);
      const payload = decodeCbor(bytes(field(decoded, 11)));
      return (field(payload, 3) as Decoded[]).map((op) => String(field(op, 0)));
    });
  }
}
