import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientPrologue, connect, generateKeyPair, routeFromControl, type MessageCarrier, type WebSocketLike } from "@mdbase-dev/sdk";
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
    expect((await client.get({ path: "a.md" }, { body: true })).body).toBe("hosted");
    client.close();
  });

  it("opens the relay pipe for a device target and never sends the prologue in clear", async () => {
    const device = randomUUID();
    const grant = randomUUID();
    const collection = randomUUID();
    const replicaKey = generateKeyPair();
    const prologue = clientPrologue(uuidBytes(collection), uuidBytes(grant), uuidBytes(device));
    const sent: unknown[] = [];
    const webSocket = fakeWebSocket((carrier) => { queueMicrotask(() => queueMicrotask(() => carrier.close())); }, sent);
    const route = routeFromControl({
      collection,
      grant,
      targets: [{ kind: "desktop", device, noise_pk: hex(replicaKey.publicKey), url: "wss://relay.test/v1/next/relay/client", relay_collection: collection }]
    }, "token");
    await expect(connect({
      app,
      reconnect: false,
      connector: gatewayConnector({ collection, grant, staticKey: generateKeyPair(), webSocket, resolveRoute: async () => route })
    })).rejects.toBeDefined();
    expect(typeof sent[0]).toBe("string");
    expect(sent.some((message) => message instanceof Uint8Array && hex(message) === hex(prologue))).toBe(false);
  });

  it("reports no route as unavailable", async () => {
    await expect(connect({
      app,
      reconnect: false,
      connector: gatewayConnector({ collection: randomUUID(), grant: randomUUID(), staticKey: generateKeyPair(), resolveRoute: async () => null })
    })).rejects.toMatchObject({ code: "unavailable", reason: "no_device_online" });
  });
});
