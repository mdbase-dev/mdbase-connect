import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CborValue, decode, encode, toHex } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { connect } from "../src/index.js";
import { readLocalLink } from "../src/node.js";
import { localLinkConnector } from "../src/transport/local-link.js";
import { clientPrologue, generateKeyPair, IkResponder } from "../src/transport/noise.js";
import { MessageCarrier, noiseChannel, WebSocketLike } from "../src/transport/noise-session.js";
import { framedPort } from "../src/transport/port.js";
import { MemoryReplica } from "../src/testing/index.js";
import { uuidv7 } from "../src/values.js";
import { clientFrame } from "../src/wire.js";

/** A daemon-side §12.4 acceptor: preamble, then IK with `{0: token, 1: hello-params}`. */
function daemon(replica: MemoryReplica, key: ReturnType<typeof generateKeyPair>, token: Uint8Array, seen: string[]) {
  return (url: string): WebSocketLike => {
    seen.push(url);
    const server: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send: (m) => queueMicrotask(() => ws.onmessage?.({ data: m.slice().buffer })),
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 })),
    };
    const ws: WebSocketLike = {
      binaryType: "blob",
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (d) => queueMicrotask(() => server.onmessage?.((d as Uint8Array).slice())),
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 })),
    };
    let prologue: Uint8Array | null = null;
    server.onmessage = async (m) => {
      if (!prologue) {
        prologue = m;
        return;
      }
      server.onmessage = null;
      const hs = new IkResponder({ prologue, staticKey: key });
      let first: Map<number, CborValue>;
      try {
        first = decode(hs.readMessage1(m).payload) as Map<number, CborValue>;
      } catch {
        return server.close();
      }
      if (toHex(first.get(0) as Uint8Array) !== toHex(token)) return server.close();
      const hello = clientFrame.enc({ kind: "request", id: 0, method: "hello", params: first.get(1)! });
      const opened = await replica.connector().open(hello);
      const { message, transport } = hs.writeMessage2(encode(opened.helloResponse));
      server.send(message);
      const port = framedPort(noiseChannel(server, transport));
      port.onframe = (f) => opened.port.send(f);
      opened.port.onframe = (f) => {
        try {
          port.send(f);
        } catch {
          // closed
        }
      };
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
}

describe("localhost link (§12.4)", () => {
  const device = uuidv7();
  const key = generateKeyPair();
  const token = crypto.getRandomValues(new Uint8Array(32));

  it("pins the daemon key, sends the prologue first and the token inside message 1", async () => {
    const replica = new MemoryReplica();
    const seen: string[] = [];
    const c = await connect({
      app: { name: "obsidian", version: "0" },
      reconnect: false,
      connector: localLinkConnector({
        collection: replica.collection,
        link: { port: 41234, token, device, noisePublicKey: key.publicKey },
        webSocket: daemon(replica, key, token, seen),
      }),
    });
    expect(seen).toEqual(["ws://127.0.0.1:41234/v1/plugin"]);
    await c.create({ path: "a.md" });
    expect(replica.allRecords).toHaveLength(1);
    c.close();
  });

  it("a squatter without the daemon key, or a wrong token, never gets a session", async () => {
    const replica = new MemoryReplica();
    const squatter = generateKeyPair();
    const opts = (k: typeof key, t: Uint8Array) => ({
      app: { name: "obsidian", version: "0" },
      reconnect: false as const,
      signal: AbortSignal.timeout(300),
      connector: localLinkConnector({
        collection: replica.collection,
        link: { port: 41234, token, device, noisePublicKey: key.publicKey },
        webSocket: daemon(replica, k, t, []),
      }),
    });
    await expect(connect(opts(squatter, token))).rejects.toBeDefined();
    await expect(connect(opts(key, new Uint8Array(32)))).rejects.toBeDefined();
    expect(replica.sessionCount).toBe(0);
  });

  it("the prologue uses the zero grant (hosting session) and the daemon device", () => {
    const p = clientPrologue(uuidToBytes(device), null, uuidToBytes(device));
    expect(p.length).toBe(64);
    expect(toHex(p.subarray(32, 48))).toBe("0".repeat(32));
  });

  it("readLocalLink applies the owner-only checks to local-link.json", async () => {
    const dir = join(import.meta.dirname, "..", ".test-link");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({ schema_version: 1, device, noise_pk: toHex(key.publicKey) }), { mode: 0o600 });
    writeFileSync(join(dir, "local-link.json"), JSON.stringify({ port: 5000, token: toHex(token) }), { mode: 0o600 });
    const link = await readLocalLink(dir);
    expect(link.port).toBe(5000);
    expect(toHex(link.token)).toBe(toHex(token));
    expect(link.device).toBe(device);
    chmodSync(join(dir, "local-link.json"), 0o644 | 0o020);
    await expect(readLocalLink(dir)).rejects.toMatchObject({ reason: "untrusted_identity" });
    rmSync(dir, { recursive: true, force: true });
  });
});
