import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientPrologue, connect, generateKeyPair, routeFromControl, type MessageCarrier, type WebSocketLike } from "@mdbase-dev/sdk/thin-client";
import { MemoryReplica, serveNoise } from "@mdbase-dev/sdk/testing";
import { gatewayConnector } from "./next-connector.js";

const app = { name: "dev.mdbase.mcp", version: "0" };
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const uuidBytes = (value: string) => Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));

/** A fake WebSocket whose server end is a carrier; `sent` records what the client sent. */
function fakeWebSocket(onServer: (carrier: MessageCarrier) => void, sent: unknown[] = []): (url: string) => WebSocketLike {
  return () => {
    const ws: WebSocketLike = {
      binaryType: "blob",
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => {
        sent.push(typeof data === "string" ? data : data.slice());
        if (typeof data !== "string") queueMicrotask(() => server.onmessage?.(data.slice()));
      },
      close: () => queueMicrotask(() => {
        ws.onclose?.({ code: 1000 });
        server.onclose?.();
      })
    };
    const server: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send: (message) => queueMicrotask(() => ws.onmessage?.({ data: message.slice().buffer })),
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1008, reason: "prologue" }))
    };
    onServer(server);
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
}

/** A fake Connect relay: `pipe_auth` in the first text frame, then u32be-framed Noise messages to the daemon end. */
function fakeRelay(onPipe: (carrier: MessageCarrier) => void, auths: unknown[], piped: Uint8Array[]): (url: string) => WebSocketLike {
  return () => {
    const ws: WebSocketLike = {
      binaryType: "blob",
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => queueMicrotask(() => fromClient(data)),
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 }))
    };
    let buffered = new Uint8Array(0);
    const daemon: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send: (message) => {
        const frame = new Uint8Array(4 + message.length);
        new DataView(frame.buffer).setUint32(0, message.length);
        frame.set(message, 4);
        queueMicrotask(() => ws.onmessage?.({ data: frame.buffer }));
      },
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 }))
    };
    const fromClient = (data: Uint8Array | string) => {
      if (typeof data === "string") {
        auths.push(JSON.parse(data));
        onPipe(daemon);
        ws.onmessage?.({ data: JSON.stringify({ type: "pipe_opened", pipe_id: randomUUID() }) });
        return;
      }
      const joined = new Uint8Array(buffered.length + data.length);
      joined.set(buffered);
      joined.set(data, buffered.length);
      let offset = 0;
      while (joined.length - offset >= 4) {
        const length = new DataView(joined.buffer, offset, 4).getUint32(0);
        if (joined.length - offset - 4 < length) break;
        const message = joined.slice(offset + 4, offset + 4 + length);
        piped.push(message);
        daemon.onmessage?.(message);
        offset += 4 + length;
      }
      buffered = joined.slice(offset);
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
}

describe("gatewayConnector", () => {
  it("sends the hosted replica the 64-byte prologue in clear before Noise message 1", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const device = randomUUID();
    const grant = randomUUID();
    const replicaKey = generateKeyPair();
    const clientKey = generateKeyPair();
    const prologue = clientPrologue(uuidBytes(replica.collection), uuidBytes(grant), uuidBytes(device));
    const sent: unknown[] = [];
    // The hosted Worker's app socket: anything but the prologue first closes the socket.
    const webSocket = fakeWebSocket((carrier) => {
      carrier.onmessage = (message) => {
        if (message.length !== 64 || hex(message) !== hex(prologue)) return carrier.close();
        serveNoise(carrier, replica.connector(), {
          staticKey: replicaKey,
          prologue,
          authorize: (key) => hex(key) === hex(clientKey.publicKey)
        });
      };
    }, sent);
    const route = routeFromControl({
      collection: replica.collection,
      grant,
      targets: [{ kind: "hosted", device, noise_pk: hex(replicaKey.publicKey), url: `wss://hosted.test/v1/hosted/app?collection=${replica.collection}` }]
    }, "token");
    const client = await connect({
      app,
      reconnect: false,
      connector: gatewayConnector({ collection: replica.collection, grant, staticKey: clientKey, webSocket, resolveRoute: async () => route })
    });
    expect(hex(sent[0] as Uint8Array)).toBe(hex(prologue));
    const write = await client.create({ path: "a.md", body: "hosted" });
    await write.confirmed;
    expect((await client.get({ path: "a.md" }, { include: { body: true } })).body).toBe("hosted");
    client.close();
  });

  it("opens the relay pipe for a device target and never sends the prologue in clear", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const device = randomUUID();
    const grant = randomUUID();
    const replicaKey = generateKeyPair();
    const prologue = clientPrologue(uuidBytes(replica.collection), uuidBytes(grant), uuidBytes(device));
    const auths: unknown[] = [];
    const piped: Uint8Array[] = [];
    // The daemon end of the pipe expects Noise message 1 first: a prologue sent ahead of it fails the handshake.
    const webSocket = fakeRelay((carrier) => serveNoise(carrier, replica.connector(), { staticKey: replicaKey, prologue }), auths, piped);
    const route = routeFromControl({
      collection: replica.collection,
      grant,
      targets: [{ kind: "desktop", device, noise_pk: hex(replicaKey.publicKey), url: "wss://relay.test/v1/next/relay/client", relay_collection: "relay-collection" }]
    }, "token");
    const client = await connect({
      app,
      reconnect: false,
      connector: gatewayConnector({ collection: replica.collection, grant, staticKey: generateKeyPair(), webSocket, resolveRoute: async () => route })
    });
    expect(auths).toEqual([{
      type: "pipe_auth", access_token: "token", collection: "relay-collection", grant, device, device_noise_pk: hex(replicaKey.publicKey)
    }]);
    expect(piped.length).toBeGreaterThan(0);
    expect(piped.some((message) => hex(message) === hex(prologue))).toBe(false);
    const write = await client.create({ path: "a.md", body: "device" });
    await write.confirmed;
    expect((await client.get({ path: "a.md" }, { include: { body: true } })).body).toBe("device");
    client.close();
  });

  it("reports no route as unavailable", async () => {
    await expect(connect({
      app,
      reconnect: false,
      connector: gatewayConnector({ collection: randomUUID(), grant: randomUUID(), staticKey: generateKeyPair(), resolveRoute: async () => null })
    })).rejects.toMatchObject({ code: "unavailable", reason: "no_device_online" });
  });
});
