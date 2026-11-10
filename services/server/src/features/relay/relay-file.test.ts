import {
  decodeRelayFileFrame,
  encodeRelayFileFrame,
  type RelayFileFrame
} from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayFileBridge,
  type RelayFileLimits
} from "./relay-file.js";
import { RelayUnavailableError } from "./relay.js";

const connectorA = "11111111-1111-4111-8111-111111111111";
const connectorB = "22222222-2222-4222-8222-222222222222";
const generation = "generation-1";
const grantA = "33333333-3333-4333-8333-333333333333";
const grantB = "55555555-5555-4555-8555-555555555555";
const transfer = "44444444-4444-4444-8444-444444444444";

const smallLimits: RelayFileLimits = {
  connectorTimeoutMs: 100,
  brokerTimeoutMs: 101,
  pendingPerGrant: 2,
  pendingPerConnector: 3,
  pendingProcess: 4
};

afterEach(() => vi.useRealTimers());

describe("RelayFileBridge admission and capacity release", () => {
  it("isolates per-grant capacity between connectors", async () => {
    const harness = relayHarness();
    const pending = harness.open(connectorA, grantA, 2);
    await harness.expectSent(connectorA, 2);

    await expectRateLimited(harness.command(connectorA, grantA));
    const independent = harness.command(connectorB, grantA);
    await harness.expectSent(connectorB, 1);

    harness.bridge.close();
    await Promise.all([...pending, independent]);
  });

  it("enforces connector capacity across grants", async () => {
    const harness = relayHarness();
    const pending = [
      ...harness.open(connectorA, grantA, 2),
      ...harness.open(connectorA, grantB, 1)
    ];
    await harness.expectSent(connectorA, 3);

    await expectRateLimited(harness.command(connectorA, grantB));
    harness.bridge.close();
    await Promise.all(pending);
  });

  it("enforces process capacity across connectors", async () => {
    const harness = relayHarness();
    const pending = [
      ...harness.open(connectorA, grantA, 2),
      ...harness.open(connectorA, grantB, 1),
      ...harness.open(connectorB, grantA, 1)
    ];
    await harness.expectSent(connectorA, 3);
    await harness.expectSent(connectorB, 1);

    await expectRateLimited(harness.command(connectorB, grantB));
    harness.bridge.close();
    await Promise.all(pending);
  });

  it("releases capacity after a connector response", async () => {
    const harness = relayHarness();
    const pending = harness.open(connectorA, grantA, 2);
    await harness.expectSent(connectorA, 2);

    harness.respond(connectorA, 0);
    await pending[0];
    const replacement = harness.command(connectorA, grantA);
    await harness.expectSent(connectorA, 3);

    harness.bridge.close();
    await Promise.all([pending[1]!, replacement]);
  });

  it("releases capacity after send failure and socket closure", async () => {
    const harness = relayHarness();
    const first = harness.command(connectorA, grantA);
    await harness.expectSent(connectorA, 1);
    harness.bridge.rejectForSocket(
      harness.socket(connectorA) as never,
      new RelayUnavailableError()
    );
    await first;

    const replacement = harness.command(connectorA, grantA);
    await harness.expectSent(connectorA, 2);
    harness.bridge.close();
    await replacement;

    const failing = relayHarness({ sendError: true });
    await failing.command(connectorA, grantA);
    const retry = failing.command(connectorA, grantA);
    await failing.expectSent(connectorA, 2);
    await retry;
  });

  it("releases capacity when a connector request times out", async () => {
    vi.useFakeTimers();
    const harness = relayHarness();
    const timedOut = harness.command(connectorA, grantA);
    await vi.advanceTimersByTimeAsync(smallLimits.connectorTimeoutMs);
    await expect(timedOut).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "connector",
        problem: { code: "unknown", server_code: "connector_timeout" }
      }
    });

    const replacement = harness.command(connectorA, grantA);
    await vi.advanceTimersByTimeAsync(smallLimits.connectorTimeoutMs);
    await expect(replacement).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "connector",
        problem: { code: "unknown", server_code: "connector_timeout" }
      }
    });
  });
});

function relayHarness(options: { sendError?: boolean } = {}) {
  const sockets = new Map([
    [connectorA, socket(options)],
    [connectorB, socket(options)]
  ]);
  const bridge = new RelayFileBridge(
    {} as never,
    (connectorId) => ({
      generation,
      socket: sockets.get(connectorId),
      capabilities: ["file-relay-v1"]
    }) as never,
    async () => generation,
    smallLimits
  );
  return {
    bridge,
    socket: (connectorId: string) => sockets.get(connectorId)!,
    command: (connectorId: string, grantId: string) =>
      bridge.handleBrokerCommand(connectorId, generation, encodedRequest(grantId)),
    open(connectorId: string, grantId: string, count: number) {
      return Array.from({ length: count }, () =>
        bridge.handleBrokerCommand(connectorId, generation, encodedRequest(grantId))
      );
    },
    async expectSent(connectorId: string, count: number) {
      await vi.waitFor(() => expect(sockets.get(connectorId)!.send).toHaveBeenCalledTimes(count));
    },
    respond(connectorId: string, callIndex: number) {
      const target = sockets.get(connectorId)!;
      const request = decodeRelayFileFrame(target.send.mock.calls[callIndex]![0]);
      bridge.handleConnectorResponse(target as never, encodeRelayFileFrame({
        kind: "upload_acknowledged",
        header: { ...request.header, type: "upload_acknowledged" },
        payload: new Uint8Array()
      }) as never);
    }
  };
}

function socket(options: { sendError?: boolean }) {
  return {
    readyState: 1,
    send: vi.fn((_bytes, _options, callback?: (error?: Error) => void) => {
      if (options.sendError) callback?.(new Error("injected send failure"));
    }),
    close: vi.fn()
  };
}

async function expectRateLimited(result: Promise<unknown>): Promise<void> {
  await expect(result).resolves.toMatchObject({
    ok: false,
    error: { kind: "connector", problem: { code: "rate_limited" } }
  });
}

function encodedRequest(grantId: string): Uint8Array {
  const frame: RelayFileFrame = {
    kind: "upload_chunk",
    header: {
      protocol_version: 1,
      type: "upload_chunk",
      request_id: crypto.randomUUID(),
      grant_id: grantId,
      transfer_id: transfer,
      chunk_index: 0
    },
    payload: new Uint8Array([1])
  };
  return encodeRelayFileFrame(frame);
}
