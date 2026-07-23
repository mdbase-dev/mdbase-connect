import { describe, expect, it, vi } from "vitest";
import {
  LocalRelayBroker,
  RelayBrokerUnavailableError,
  type RelayBrokerCommand
} from "./relay-broker.js";

const connectorId = "01234567-89ab-4def-8123-456789abcdef";
const policy: RelayBrokerCommand = {
  version: 1,
  kind: "policy",
  message: { type: "policy_snapshot", grants: [] }
};

describe("local relay broker", () => {
  it("routes only to the exact connector session generation", async () => {
    const broker = new LocalRelayBroker();
    const handle = vi.fn(async () => ({ version: 1 as const, ok: true as const, value: "delivered" }));
    const binding = await broker.bind({
      connectorId,
      generation: "7",
      handle,
      replaced: vi.fn()
    });

    await expect(broker.request(connectorId, "7", policy, 10)).resolves.toEqual({
      version: 1,
      ok: true,
      value: "delivered"
    });
    await expect(broker.request(connectorId, "6", policy, 10))
      .rejects.toBeInstanceOf(RelayBrokerUnavailableError);
    expect(handle).toHaveBeenCalledOnce();

    await binding.close();
    await expect(broker.request(connectorId, "7", policy, 10))
      .rejects.toBeInstanceOf(RelayBrokerUnavailableError);
  });

  it("fences older bindings but ignores stale replacement broadcasts", async () => {
    const broker = new LocalRelayBroker();
    const replaced = vi.fn();
    await broker.bind({
      connectorId,
      generation: "99",
      handle: async () => ({ version: 1, ok: true }),
      replaced
    });

    await broker.publishReplacement(connectorId, "98");
    await broker.publishReplacement(connectorId, "99");
    expect(replaced).not.toHaveBeenCalled();

    await broker.publishReplacement(connectorId, "100");
    expect(replaced).toHaveBeenCalledOnce();
  });

  it("fails readiness and routing after shutdown", async () => {
    const broker = new LocalRelayBroker();
    await broker.close();
    await expect(broker.ready()).rejects.toBeInstanceOf(RelayBrokerUnavailableError);
    await expect(broker.request(connectorId, "1", policy, 10))
      .rejects.toBeInstanceOf(RelayBrokerUnavailableError);
  });
});
