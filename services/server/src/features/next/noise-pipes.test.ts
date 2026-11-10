import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { LocalRelayBroker } from "../relay/relay-broker.js";
import { NoisePipes, registerNoisePipeClientRoute } from "./noise-pipes.js";

const cases = JSON.parse(readFileSync(new URL("../../../../../runtime/conformance/relay-grant-refusals.json", import.meta.url), "utf8")) as {
  name: string; reason: string; close_code: number;
}[];

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
    this.emit("close");
  });
}

it.each(cases)("maps the daemon refusal for $name through the broker to the client", async ({ reason, close_code }) => {
  const db = { query: vi.fn(async () => ({ rows: [{ connector_id: "connector", relay_generation: "1", noise_pk: Buffer.alloc(32, 1) }] })) } as unknown as DatabasePool;
  const broker = new LocalRelayBroker();
  const pipes = new NoisePipes(db, broker);
  const device = new Socket();
  const client = new Socket();
  const get = vi.fn();
  registerNoisePipeClientRoute({ get } as unknown as FastifyInstance, { db, broker });
  const handle = get.mock.calls[0]![2] as (socket: WebSocket) => void;
  try {
    await pipes.attach(device as unknown as WebSocket, "connector", "1", "device");
    handle(client as unknown as WebSocket);
    client.emit("message", Buffer.from(JSON.stringify({
      type: "pipe_auth", access_token: "fixture-token", collection: "collection", grant: "grant",
      device: "device", device_noise_pk: Buffer.alloc(32, 1).toString("hex"),
    })), false);
    await vi.waitFor(() => expect(device.send).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    const opened = JSON.parse(String(device.send.mock.calls[0]![0])) as { pipe_id: string };
    pipes.handleDeviceClose(device as unknown as WebSocket, { type: "pipe_close", pipe_id: opened.pipe_id, reason });
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledWith(close_code, reason));
  } finally {
    client.close();
    pipes.close();
    await broker.close();
  }
});
