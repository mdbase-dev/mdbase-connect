import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../src/cbor.js";
import { generateKeyPair, IkInitiator, IkResponder, keyPairFromSecret, NoiseError } from "../src/transport/noise.js";

const fx = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/noise-ik-25519-chachapoly-sha256.json"), "utf8"),
) as {
  vector: {
    init_prologue: string;
    init_static: string;
    init_ephemeral: string;
    init_remote_static: string;
    resp_static: string;
    resp_ephemeral: string;
    handshake_hash: string;
    messages: { payload: string; ciphertext: string }[];
  };
};
const v = fx.vector;

describe("Noise IK against the cacophony vector", () => {
  it("reproduces every message and the handshake hash", async () => {
    const init = new IkInitiator({
      prologue: fromHex(v.init_prologue),
      staticKey: keyPairFromSecret(fromHex(v.init_static)),
      remoteStatic: fromHex(v.init_remote_static),
      ephemeral: keyPairFromSecret(fromHex(v.init_ephemeral)),
    });
    const resp = new IkResponder({
      prologue: fromHex(v.init_prologue),
      staticKey: keyPairFromSecret(fromHex(v.resp_static)),
      ephemeral: keyPairFromSecret(fromHex(v.resp_ephemeral)),
    });
    const [m0, m1, ...rest] = v.messages;

    const c0 = await init.writeMessage1(fromHex(m0!.payload));
    expect(toHex(c0)).toBe(m0!.ciphertext);
    const r0 = resp.readMessage1(c0);
    expect(toHex(r0.payload)).toBe(m0!.payload);
    expect(toHex(r0.remoteStatic)).toBe(toHex(keyPairFromSecret(fromHex(v.init_static)).publicKey));

    const { message: c1, transport: rt } = resp.writeMessage2(fromHex(m1!.payload));
    expect(toHex(c1)).toBe(m1!.ciphertext);
    const { payload: p1, transport: it } = await init.readMessage2(c1);
    expect(toHex(p1)).toBe(m1!.payload);
    expect(toHex(it.handshakeHash)).toBe(v.handshake_hash);
    expect(toHex(rt.handshakeHash)).toBe(v.handshake_hash);

    // Transport messages alternate initiator → responder, responder → initiator.
    rest.forEach((m, i) => {
      const [tx, rx] = i % 2 === 0 ? [it.send, rt.recv] : [rt.send, it.recv];
      const c = tx.encrypt(new Uint8Array(0), fromHex(m.payload));
      expect(toHex(c)).toBe(m.ciphertext);
      expect(toHex(rx.decrypt(new Uint8Array(0), c))).toBe(m.payload);
    });
  });

  it("fails when the prologue differs", async () => {
    const rs = generateKeyPair();
    const init = new IkInitiator({
      prologue: new Uint8Array([1]),
      staticKey: generateKeyPair(),
      remoteStatic: rs.publicKey,
    });
    const resp = new IkResponder({ prologue: new Uint8Array([2]), staticKey: rs });
    const m1 = await init.writeMessage1(new Uint8Array(0));
    expect(() => resp.readMessage1(m1)).toThrow(NoiseError);
  });

  it("fails when the responder key is not the expected one", async () => {
    const init = new IkInitiator({
      prologue: new Uint8Array(0),
      staticKey: generateKeyPair(),
      remoteStatic: generateKeyPair().publicKey,
    });
    const resp = new IkResponder({ prologue: new Uint8Array(0), staticKey: generateKeyPair() });
    const m1 = await init.writeMessage1(new Uint8Array(0));
    expect(() => resp.readMessage1(m1)).toThrow(NoiseError);
  });
});

describe("Noise hardening", () => {
  it("the responder refuses a second message 1", async () => {
    const rs = generateKeyPair();
    const resp = new IkResponder({ prologue: new Uint8Array(0), staticKey: rs });
    const mk = () =>
      new IkInitiator({ prologue: new Uint8Array(0), staticKey: generateKeyPair(), remoteStatic: rs.publicKey });
    resp.readMessage1(await mk().writeMessage1(new Uint8Array(0)));
    const again = await mk().writeMessage1(new Uint8Array(0));
    expect(() => resp.readMessage1(again)).toThrow(NoiseError);
  });

  it("an all-zero remote static key is rejected", async () => {
    const init = new IkInitiator({
      prologue: new Uint8Array(0),
      staticKey: generateKeyPair(),
      remoteStatic: new Uint8Array(32),
    });
    await expect(init.writeMessage1(new Uint8Array(0))).rejects.toThrow(NoiseError);
  });
});
