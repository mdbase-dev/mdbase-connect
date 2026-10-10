import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, Server } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toHex } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { connect } from "../src/index.js";
import { memoryKeyStorage, loadOrCreateClientKey } from "../src/keys.js";
import { daemonIdentityFile, defaultDaemonStateDir, ipcConnector, readDaemonIdentity } from "../src/node.js";
import { inProcessConnector } from "../src/transport/inprocess.js";
import { clientPrologue, generateKeyPair } from "../src/transport/noise.js";
import { MessageCarrier, streamCarrier, WebSocketLike } from "../src/transport/noise-session.js";
import { portPair } from "../src/transport/port.js";
import { relayConnector } from "../src/transport/relay.js";
import { MemoryReplica } from "../src/testing/index.js";
import { serveNoise } from "../src/testing/noise-server.js";
import { uuidv7 } from "../src/values.js";

const app = { name: "t", version: "0" };

/** A pair of fake WebSockets: the client end and a server-side carrier. */
function fakeWebSocket(onServer: (c: MessageCarrier) => void): (url: string) => WebSocketLike {
  return () => {
    const ws: WebSocketLike = {
      binaryType: "blob",
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (d) => queueMicrotask(() => server.onmessage?.((d as Uint8Array).slice())),
      close: () => {
        queueMicrotask(() => {
          ws.onclose?.({ code: 1000 });
          server.onclose?.();
        });
      },
    };
    const server: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send: (m) => queueMicrotask(() => ws.onmessage?.({ data: m.slice().buffer })),
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 })),
    };
    onServer(server);
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
}

describe("relay transport (Noise over WebSocket)", () => {
  it("connects, authenticates and serves the client API end to end", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const device = uuidv7();
    const grant = uuidv7();
    const replicaKey = generateKeyPair();
    const clientKey = await loadOrCreateClientKey("app", { storage: memoryKeyStorage() });
    const prologue = clientPrologue(uuidToBytes(replica.collection), uuidToBytes(grant), uuidToBytes(device));
    const ws = fakeWebSocket((carrier) =>
      serveNoise(carrier, replica.connector(), {
        staticKey: replicaKey,
        prologue,
        authorize: (k) => toHex(k) === toHex(clientKey.publicKey),
      }),
    );
    const c = await connect({
      app,
      connector: relayConnector({
        collection: replica.collection,
        grant,
        staticKey: clientKey,
        webSocket: ws,
        resolveRoute: async () => ({ url: "wss://relay.test/s/1", targetDevice: device, noisePublicKey: replicaKey.publicKey }),
      }),
    });
    const w = await c.create({ path: "a.md", body: "x".repeat(200_000) }); // spans many Noise messages
    await w.confirmed;
    expect((await c.get({ path: "a.md" }, { body: true })).body).toHaveLength(200_000);
    c.close();
  });

  it("a client key without a grant is refused as unauthenticated", async () => {
    const replica = new MemoryReplica();
    const device = uuidv7();
    const replicaKey = generateKeyPair();
    const prologue = clientPrologue(uuidToBytes(replica.collection), null, uuidToBytes(device));
    const ws = fakeWebSocket((carrier) =>
      serveNoise(carrier, replica.connector(), { staticKey: replicaKey, prologue, authorize: () => false }),
    );
    await expect(
      connect({
        app,
        connector: relayConnector({
          collection: replica.collection,
          grant: null,
          staticKey: generateKeyPair(),
          webSocket: ws,
          resolveRoute: async () => ({ url: "wss://x", targetDevice: device, noisePublicKey: replicaKey.publicKey }),
        }),
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("a wrong replica key fails the handshake", async () => {
    const replica = new MemoryReplica();
    const device = uuidv7();
    const prologue = clientPrologue(uuidToBytes(replica.collection), null, uuidToBytes(device));
    const ws = fakeWebSocket((carrier) => serveNoise(carrier, replica.connector(), { staticKey: generateKeyPair(), prologue }));
    await expect(
      connect({
        app,
        reconnect: false,
        connector: relayConnector({
          collection: replica.collection,
          grant: null,
          staticKey: generateKeyPair(),
          webSocket: ws,
          resolveRoute: async () => ({ url: "wss://x", targetDevice: device, noisePublicKey: generateKeyPair().publicKey }),
        }),
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toBeDefined();
  });

  it("private collection with no device online: waits, then connects", async () => {
    const replica = new MemoryReplica();
    const device = uuidv7();
    const replicaKey = generateKeyPair();
    const prologue = clientPrologue(uuidToBytes(replica.collection), null, uuidToBytes(device));
    const ws = fakeWebSocket((carrier) => serveNoise(carrier, replica.connector(), { staticKey: replicaKey, prologue }));
    let online = false;
    const waits: string[] = [];
    const connector = relayConnector({
      collection: replica.collection,
      grant: null,
      staticKey: generateKeyPair(),
      webSocket: ws,
      resolveRoute: async () =>
        online ? { url: "wss://x", targetDevice: device, noisePublicKey: replicaKey.publicKey } : null,
    });
    await expect(connect({ app, connector })).rejects.toMatchObject({ code: "unavailable", reason: "no_device_online" });
    setTimeout(() => (online = true), 50);
    const c = await connect({ app, connector, reconnect: { minDelayMs: 20 }, waitForDevice: true, onWaiting: (e) => waits.push(e.reason!) });
    expect(waits[0]).toBe("no_device_online");
    expect(c.link).toBe("open");
    c.close();
  });
});

describe("local IPC (Noise over a Unix socket)", () => {
  const dir = join(import.meta.dirname, "..", ".test-ipc");
  const path = join(dir, "replica.sock");
  const replica = new MemoryReplica({ confirmDelayMs: 0 });
  const daemonKey = generateKeyPair();
  const device = uuidv7();
  let server: Server;

  beforeAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({ device, noise_pk: toHex(daemonKey.publicKey) }), {
      mode: 0o600,
    });
    server = createServer((sock) => {
      const bs = {
        ondata: null as ((b: Uint8Array) => void) | null,
        onclose: null as (() => void) | null,
        write: (b: Uint8Array) => void sock.write(b),
        close: () => sock.destroy(),
      };
      sock.on("data", (d: Buffer) => bs.ondata?.(new Uint8Array(d)));
      sock.on("close", () => bs.onclose?.());
      // The daemon reads the clear prologue record first, then serves Noise with it.
      const carrier = streamCarrier(bs);
      carrier.onmessage = (pro) => {
        const expected = clientPrologue(uuidToBytes(replica.collection), null, uuidToBytes(device));
        if (toHex(pro) !== toHex(expected)) return sock.destroy();
        serveNoise(carrier, replica.connector(), { staticKey: daemonKey, prologue: pro });
      };
    });
    await new Promise<void>((r) => server.listen(path, r));
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hosting app connects through the daemon socket", async () => {
    const step = (name: string) => (e: unknown) => {
      throw new Error(`${name}: ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`);
    };
    const c = await connect({
      app,
      reconnect: false,
      signal: AbortSignal.timeout(3000),
      connector: ipcConnector({
        collection: replica.collection,
        grant: null,
        staticKey: generateKeyPair(),
        path,
        stateDir: dir,
      }),
    }).catch(step("connect"));
    const w = await c.create({ path: "ipc.md" }).catch(step("create"));
    await Promise.race([
      w.confirmed,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`confirm: still ${w.state}`)), 2000)),
    ]);
    expect((await c.get({ path: "ipc.md" })).path).toBe("ipc.md");
    c.close();
  });

  it("the identity never comes from beside a named pipe", () => {
    expect(() => daemonIdentityFile("\\\\.\\pipe", "win32")).toThrow(/local path/);
    expect(() => daemonIdentityFile("//./pipe", "win32")).toThrow(/local path/);
    expect(daemonIdentityFile("C:\\Users\\u\\AppData\\Local\\mdbase\\state", "win32")).toBe(
      "C:\\Users\\u\\AppData\\Local\\mdbase\\state\\daemon.json",
    );
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
    expect(defaultDaemonStateDir("win32")).toBe("C:\\Users\\u\\AppData\\Local\\mdbase\\state");
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  });

  it("a group- or world-writable identity file or directory is refused", async () => {
    await expect(readDaemonIdentity(dir)).resolves.toMatchObject({ device });
    chmodSync(join(dir, "daemon.json"), 0o666);
    await expect(readDaemonIdentity(dir)).rejects.toMatchObject({ code: "unauthenticated", reason: "untrusted_identity" });
    chmodSync(join(dir, "daemon.json"), 0o600);
    chmodSync(dir, 0o777);
    await expect(readDaemonIdentity(dir)).rejects.toMatchObject({ reason: "untrusted_identity" });
    chmodSync(dir, 0o700);
  });

  it("a symlinked identity file is refused; XDG_STATE_HOME is ignored", async () => {
    const real = join(dir, "real.json");
    writeFileSync(real, readFileSync(join(dir, "daemon.json")), { mode: 0o600 });
    renameSync(join(dir, "daemon.json"), join(dir, "saved.json"));
    symlinkSync(real, join(dir, "daemon.json"));
    await expect(readDaemonIdentity(dir)).rejects.toMatchObject({ reason: "untrusted_identity" });
    rmSync(join(dir, "daemon.json"));
    renameSync(join(dir, "saved.json"), join(dir, "daemon.json"));
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/elsewhere";
    expect(defaultDaemonStateDir("linux")).toBe(join(homedir(), ".local", "state", "mdbase"));
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
  });

  it("no daemon: unavailable / daemon_not_running", async () => {
    await expect(
      connect({
        app,
        connector: ipcConnector({
          collection: replica.collection,
          grant: null,
          staticKey: generateKeyPair(),
          path: join(dir, "missing.sock"),
          daemon: { device, noisePublicKey: daemonKey.publicKey },
        }),
      }),
    ).rejects.toMatchObject({ code: "unavailable", reason: "daemon_not_running" });
  });
});

describe("in-process transport", () => {
  it("exchanges frames as JS values with the runtime's port", async () => {
    const replica = new MemoryReplica();
    // A stand-in runtime: hands out ports bridged to the memory replica.
    const runtime = {
      connect() {
        const [mine, theirs] = portPair();
        theirs.onframe = async (hello) => {
          theirs.onframe = null;
          const opened = await replica.connector().open(hello);
          theirs.send(opened.helloResponse);
          const safe = (fn: () => void) => {
            try {
              fn();
            } catch {
              // the other side closed
            }
          };
          theirs.onframe = (f) => safe(() => opened.port.send(f));
          opened.port.onframe = (f) => safe(() => theirs.send(f));
        };
        return mine;
      },
    };
    const c = await connect({ app, connector: inProcessConnector(runtime) });
    expect(c.collection).toBe(replica.collection);
    await c.create({ path: "a.md" });
    expect(replica.allRecords).toHaveLength(1);
    c.close();
  });
});
