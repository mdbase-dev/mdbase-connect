// The Noise connector for MCP tool calls: the relay pipe to a user device (Private),
// or a direct WebSocket to the hosted replica (cloud copy).
//
// This is the SDK's `relayConnector` with one difference on the direct path. The
// hosted Worker's app socket reads the 64-byte client prologue first, in clear, as
// its own WebSocket message, and only then Noise message 1; without it the Worker
// closes the socket (1008 "prologue"). The SDK build pinned here sends Noise message 1
// straight away, so the gateway builds the target itself. Relay pipes never send the
// prologue in clear: the relay gives the daemon the same values in `pipe_open`.
import {
  clientPrologue, mdbaseError, noiseConnector, relayPipeCarrier, webSocketCarrier,
  type Connector, type KeyPair, type RelayRoute, type StaticKey, type WebSocketFactory
} from "@mdbase-dev/sdk";

export interface GatewayConnectorOptions {
  collection: string;
  grant: string;
  staticKey: KeyPair | StaticKey;
  resolveRoute: () => Promise<RelayRoute | null>;
  webSocket?: WebSocketFactory;
}

export function gatewayConnector(o: GatewayConnectorOptions): Connector {
  const collection = uuidBytes(o.collection);
  const grant = uuidBytes(o.grant);
  return noiseConnector({
    description: `relay:${o.collection}`,
    staticKey: o.staticKey,
    target: async () => {
      const route = await o.resolveRoute();
      if (!route) throw mdbaseError("unavailable", "no device of this collection is online", "no_device_online");
      const prologue = clientPrologue(collection, grant, uuidBytes(route.targetDevice));
      const pipe = route.pipe;
      return {
        prologue,
        ...(pipe ? {} : { preamble: prologue }),
        remoteStatic: route.noisePublicKey,
        device: route.targetDevice,
        openCarrier: (signal) => pipe
          ? relayPipeCarrier(route.url, {
              accessToken: pipe.accessToken,
              collection: pipe.collection,
              grant: o.grant,
              device: route.targetDevice,
              devicePublicKey: route.noisePublicKey
            }, o.webSocket, signal)
          : webSocketCarrier(route.url, o.webSocket, signal)
      };
    }
  });
}

function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw mdbaseError("invalid_request", "not a UUID");
  return Uint8Array.from(value.replaceAll("-", "").match(/../g)!, (byte) => Number.parseInt(byte, 16));
}
