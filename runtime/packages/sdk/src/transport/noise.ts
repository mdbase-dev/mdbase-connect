/**
 * `Noise_IK_25519_ChaChaPoly_SHA256` (the Noise Protocol Framework, revision 34),
 * initiator and responder, for client sessions (`replica-client-api.md` §12.3).
 *
 * IK: the initiator (the client, static key = the grant's `client_pk`) already knows
 * the responder's static key (the replica's enrolled `noise_pk`, from the control
 * plane). One round trip gives mutual authentication.
 *
 * ```text
 * <- s
 * ...
 * -> e, es, s, ss
 * <- e, ee, se
 * ```
 *
 * Checked against the cacophony test vector in `test/fixtures/`.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
const DHLEN = 32;
const HASHLEN = 32;
/** Noise's maximum message size. */
export const MAX_MESSAGE = 65535;
const TAGLEN = 16;
/** The most plaintext one transport message can carry. */
export const MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN;
/** Rekeying is not used: sessions end after 2^30 messages (§12.3). */
export const MAX_SESSION_MESSAGES = 2 ** 30;

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * A static key the SDK can use without seeing the secret: a non-extractable WebCrypto
 * key implements `dh` with `deriveBits`. A {@link KeyPair} is also accepted.
 */
export interface StaticKey {
  publicKey: Uint8Array;
  dh(remotePublic: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export function staticKeyOf(k: KeyPair | StaticKey): StaticKey {
  if ("dh" in k) return k;
  return { publicKey: k.publicKey, dh: (pk) => dh(k.secretKey, pk) };
}

async function staticDh(k: StaticKey, pk: Uint8Array): Promise<Uint8Array> {
  let out: Uint8Array;
  try {
    out = await k.dh(pk);
  } catch (e) {
    if (e instanceof NoiseError) throw e;
    throw new NoiseError("invalid public key");
  }
  return checkDh(out);
}

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Reject all-zero outputs: a low-order or all-zero public key. */
export function checkDh(out: Uint8Array): Uint8Array {
  let acc = 0;
  for (const b of out) acc |= b;
  if (acc === 0) throw new NoiseError("invalid public key (all-zero shared secret)");
  return out;
}

function dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  let out: Uint8Array;
  try {
    out = x25519.getSharedSecret(sk, pk);
  } catch {
    throw new NoiseError("invalid public key");
  }
  return checkDh(out);
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, ikm);
  const o1 = hmac(sha256, temp, Uint8Array.of(1));
  const o2 = hmac(sha256, temp, concat(o1, Uint8Array.of(2)));
  return [o1, o2];
}

function nonce12(n: number): Uint8Array {
  // 32 bits of zeros followed by the 64-bit little-endian counter.
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  v.setUint32(4, n >>> 0, true);
  v.setUint32(8, Math.floor(n / 2 ** 32), true);
  return b;
}

export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

/** A Noise CipherState. */
export class CipherState {
  private n = 0;
  constructor(private k: Uint8Array | null = null) {}

  hasKey(): boolean {
    return this.k !== null;
  }

  get count(): number {
    return this.n;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext;
    if (this.n >= MAX_SESSION_MESSAGES) throw new NoiseError("session message limit reached");
    const c = chacha20poly1305(this.k, nonce12(this.n), ad).encrypt(plaintext);
    this.n++;
    return c;
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext;
    if (this.n >= MAX_SESSION_MESSAGES) throw new NoiseError("session message limit reached");
    let p: Uint8Array;
    try {
      p = chacha20poly1305(this.k, nonce12(this.n), ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError("decryption failed");
    }
    this.n++;
    return p;
  }
}

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cs = new CipherState();

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h;
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cs = new CipherState(k);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const c = this.cs.encrypt(this.h, plaintext);
    this.mixHash(c);
    return c;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const p = this.cs.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return p;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
    return [new CipherState(k1), new CipherState(k2)];
  }
}

/** The two transport ciphers after the handshake, and the handshake hash. */
export interface NoiseTransport {
  send: CipherState;
  recv: CipherState;
  /** The handshake hash: a unique session binding. */
  handshakeHash: Uint8Array;
  /** The peer's static public key. */
  remoteStatic: Uint8Array;
}

export interface InitiatorOptions {
  prologue: Uint8Array;
  staticKey: KeyPair | StaticKey;
  remoteStatic: Uint8Array;
  /** Test hook: a fixed ephemeral key. Production leaves it unset. */
  ephemeral?: KeyPair;
}

/** The initiator (client) side of IK. */
export class IkInitiator {
  private ss = new SymmetricState(PROTOCOL_NAME);
  private e: KeyPair;
  private state: "start" | "sent" | "done" = "start";

  constructor(private opts: InitiatorOptions) {
    if (opts.remoteStatic.length !== DHLEN) throw new NoiseError("remote static key must be 32 bytes");
    this.e = opts.ephemeral ?? generateKeyPair();
    this.ss.mixHash(opts.prologue);
    this.ss.mixHash(opts.remoteStatic);
  }

  /** `-> e, es, s, ss` with `payload`. */
  async writeMessage1(payload: Uint8Array): Promise<Uint8Array> {
    if (this.state !== "start") throw new NoiseError("handshake out of order");
    this.state = "sent";
    const st = staticKeyOf(this.opts.staticKey);
    const ss = this.ss;
    ss.mixHash(this.e.publicKey);
    ss.mixKey(dh(this.e.secretKey, this.opts.remoteStatic));
    const s = ss.encryptAndHash(st.publicKey);
    ss.mixKey(await staticDh(st, this.opts.remoteStatic));
    const p = ss.encryptAndHash(payload);
    const msg = concat(this.e.publicKey, s, p);
    if (msg.length > MAX_MESSAGE) throw new NoiseError("handshake message too large");
    return msg;
  }

  /** `<- e, ee, se`; returns the responder's payload and the transport ciphers. */
  async readMessage2(msg: Uint8Array): Promise<{ payload: Uint8Array; transport: NoiseTransport }> {
    if (this.state !== "sent") throw new NoiseError("handshake out of order");
    if (msg.length < DHLEN + TAGLEN) throw new NoiseError("handshake message too short");
    this.state = "done";
    const ss = this.ss;
    const re = msg.subarray(0, DHLEN);
    ss.mixHash(re);
    ss.mixKey(dh(this.e.secretKey, re));
    ss.mixKey(await staticDh(staticKeyOf(this.opts.staticKey), re));
    const payload = ss.decryptAndHash(msg.subarray(DHLEN));
    const [c1, c2] = ss.split();
    return {
      payload,
      transport: { send: c1, recv: c2, handshakeHash: ss.h, remoteStatic: this.opts.remoteStatic },
    };
  }
}

export interface ResponderOptions {
  prologue: Uint8Array;
  staticKey: KeyPair;
  ephemeral?: KeyPair;
}

/**
 * The responder (replica) side of IK. The SDK uses it for tests and for apps that
 * host a replica in the same JS process and accept remote clients.
 */
export class IkResponder {
  private ss = new SymmetricState(PROTOCOL_NAME);
  private e: KeyPair;
  private rs: Uint8Array | null = null;
  private re: Uint8Array | null = null;
  private state: "start" | "read" | "done" = "start";

  constructor(private opts: ResponderOptions) {
    this.e = opts.ephemeral ?? generateKeyPair();
    this.ss.mixHash(opts.prologue);
    this.ss.mixHash(opts.staticKey.publicKey);
  }

  /** Read `-> e, es, s, ss`; returns the initiator's static key and payload. */
  readMessage1(msg: Uint8Array): { remoteStatic: Uint8Array; payload: Uint8Array } {
    if (this.state !== "start") throw new NoiseError("handshake out of order");
    // Any failure below leaves the responder unusable: a handshake is single-shot.
    this.state = "done";
    if (msg.length < DHLEN + DHLEN + TAGLEN + TAGLEN) throw new NoiseError("handshake message too short");
    const ss = this.ss;
    const re = msg.subarray(0, DHLEN).slice();
    ss.mixHash(re);
    ss.mixKey(dh(this.opts.staticKey.secretKey, re));
    const rs = ss.decryptAndHash(msg.subarray(DHLEN, DHLEN + DHLEN + TAGLEN));
    ss.mixKey(dh(this.opts.staticKey.secretKey, rs));
    const payload = ss.decryptAndHash(msg.subarray(DHLEN + DHLEN + TAGLEN));
    this.re = re;
    this.rs = rs;
    this.state = "read";
    return { remoteStatic: rs, payload };
  }

  /** `<- e, ee, se` with `payload`. */
  writeMessage2(payload: Uint8Array): { message: Uint8Array; transport: NoiseTransport } {
    if (this.state !== "read" || !this.re || !this.rs) throw new NoiseError("handshake out of order");
    this.state = "done";
    const ss = this.ss;
    ss.mixHash(this.e.publicKey);
    ss.mixKey(dh(this.e.secretKey, this.re));
    ss.mixKey(dh(this.e.secretKey, this.rs));
    const p = ss.encryptAndHash(payload);
    const [c1, c2] = ss.split();
    return {
      message: concat(this.e.publicKey, p),
      transport: { send: c2, recv: c1, handshakeHash: ss.h, remoteStatic: this.rs },
    };
  }
}

const PROLOGUE_TAG = new TextEncoder().encode("mdbase/v1/client");
const NIL_UUID = new Uint8Array(16);

/**
 * The client session prologue: `"mdbase/v1/client" ‖ collection ‖ grant ID ‖ target
 * device ID`, each ID as 16 raw bytes. A session without a grant (the hosting app)
 * uses the nil UUID for the grant ID.
 */
export function clientPrologue(collection: Uint8Array, grant: Uint8Array | null, targetDevice: Uint8Array): Uint8Array {
  for (const [n, b] of [
    ["collection", collection],
    ["target device", targetDevice],
  ] as const) {
    if (b.length !== 16) throw new NoiseError(`${n} ID must be 16 bytes`);
  }
  if (grant && grant.length !== 16) throw new NoiseError("grant ID must be 16 bytes");
  return concat(PROLOGUE_TAG, collection, grant ?? NIL_UUID, targetDevice);
}
