/**
 * @mdbase-dev/sdk/thin-client: for code that brings its own connection, such
 * as a server, a CLI or an Obsidian-plugin-style integration. It is the
 * collection API (`./collection-api.js`) plus what makes a connection:
 * `connect`, the Noise, relay and in-process transports, keys, the session and
 * the wire encoding. It never bundles manifest validation
 * (scripts/bundle-boundaries.mjs).
 *
 * An app that calls `createMdbase` needs none of the additions and imports the
 * root entry.
 */
export * from "./collection-api.js";
export * from "./cbor.js";
export { SchemaError } from "./codec.js";
export type { Codec } from "./codec.js";
export type { AttachmentContentV1, AttachmentRefV1 } from "./attachment-wire.js";
export type { AppliedPrefixParams, SubmitParams } from "./wire.js";
export { connect } from "./client.js";
export type { ClientOptions } from "./client.js";
export { Session, API_VERSIONS } from "./session.js";
export { framedPort, portPair, RecordReader } from "./transport/port.js";
export type { ByteChannel, Connector, FramePort, OpenedPort } from "./transport/port.js";
export { relayConnector } from "./transport/relay.js";
export { duplexCarrier, nextRelayConnector, orderTargets } from "./transport/next-relay.js";
export type {
  AuthenticatedRelayByteDuplex, NextBridge, NextRelayConnectorOptions, NextRouteResponse, NextRouteTarget,
} from "./transport/next-relay.js";
export type { RelayConnectorOptions, RelayRoute } from "./transport/relay.js";
export {
  noiseConnector,
  noiseChannel,
  streamCarrier,
  webSocketCarrier,
  SESSION_LIFETIME_MS,
} from "./transport/noise-session.js";
export type {
  ByteStream,
  MessageCarrier,
  NoiseConnectorOptions,
  NoiseTarget,
  WebSocketFactory,
  WebSocketLike,
} from "./transport/noise-session.js";
export {
  clientPrologue,
  generateKeyPair,
  IkInitiator,
  IkResponder,
  keyPairFromSecret,
  NoiseError,
  staticKeyOf,
} from "./transport/noise.js";
export type { NoiseTransport } from "./transport/noise.js";
export { localLinkConnector, localLinkFirstPayload } from "./transport/local-link.js";
export type { LocalLink, LocalLinkConnectorOptions } from "./transport/local-link.js";
export type { KeyPair, StaticKey } from "./transport/noise.js";
export { indexedDbKeyStorage, loadOrCreateClientKey, memoryKeyStorage } from "./keys.js";
export type { ClientKey, KeyStorage, LoadKeyOptions, StoredKey } from "./keys.js";
export { pipeCloseError, relayPipeCarrier } from "./transport/relay-pipe.js";
export type { PipeAuth } from "./transport/relay-pipe.js";
export { controlRouteResolver, routeFromControl } from "./transport/control-route.js";
export type { ControlRouteOptions, ControlRouteResponse, ControlRouteTarget } from "./transport/control-route.js";
export { inProcessConnector } from "./transport/inprocess.js";
export type { InProcessConnectOptions, InProcessRuntime } from "./transport/inprocess.js";
export { WasmRuntime } from "./runtime/wasm.js";
export type { OpenConfig, QueryExecutionProfile, RuntimeInfo } from "./runtime/wasm.js";
// The account-key (AK1) surface lives at `@mdbase-dev/sdk/account`: it carries Argon2id,
// Ed25519 and the strength meter, which the thin client does not need.
export {
  COLLECTION_UNAVAILABLE_REASONS,
  collectionUnavailableError,
  isCollectionUnavailableReason,
  parseCollectionAvailability,
  type CollectionAvailability,
  type CollectionUnavailableReason,
} from "./collection-availability.js";
// Grants for Private collections (OAuth PKCE + a client Noise key) live at
// `@mdbase-dev/sdk/app-grant`, kept out of this entry.
