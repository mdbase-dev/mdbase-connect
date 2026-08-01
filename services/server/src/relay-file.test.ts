import { encodeRelayFileFrame, type RelayFileFrame } from "@mdbase/connect-protocol";
import { describe, expect, it, vi } from "vitest";
import { RelayFileBridge } from "./relay-file.js";

const connectorA = "11111111-1111-4111-8111-111111111111";
const connectorB = "22222222-2222-4222-8222-222222222222";
const generation = "generation-1";
const grant = "33333333-3333-4333-8333-333333333333";
const transfer = "44444444-4444-4444-8444-444444444444";

describe("RelayFileBridge admission", () => {
  it("isolates the per-grant limit between connectors", async () => {
    const socketA = socket();
    const socketB = socket();
    const sessions = new Map([
      [connectorA, { generation, socket: socketA, capabilities: ["file-relay-v1"] }],
      [connectorB, { generation, socket: socketB, capabilities: ["file-relay-v1"] }]
    ]);
    const bridge = new RelayFileBridge(
      {} as never,
      (connectorId) => sessions.get(connectorId) as never,
      async () => generation
    );
    const pending = Array.from({ length: 8 }, () =>
      bridge.handleBrokerCommand(connectorA, generation, encodedRequest())
    );
    await vi.waitFor(() => expect(socketA.send).toHaveBeenCalledTimes(8));

    const rejected = await bridge.handleBrokerCommand(
      connectorA,
      generation,
      encodedRequest()
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { kind: "connector", problem: { code: "rate_limited" } }
    });

    const independent = bridge.handleBrokerCommand(
      connectorB,
      generation,
      encodedRequest()
    );
    await vi.waitFor(() => expect(socketB.send).toHaveBeenCalledTimes(1));
    bridge.close();
    await Promise.all([...pending, independent]);
  });
});

function socket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn()
  };
}

function encodedRequest(): Uint8Array {
  const frame: RelayFileFrame = {
    kind: "upload_chunk",
    header: {
      protocol_version: 1,
      type: "upload_chunk",
      request_id: crypto.randomUUID(),
      grant_id: grant,
      transfer_id: transfer,
      chunk_index: 0
    },
    payload: new Uint8Array([1])
  };
  return encodeRelayFileFrame(frame);
}
