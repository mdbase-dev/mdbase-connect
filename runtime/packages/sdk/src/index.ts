/**
 * @mdbase-dev/sdk: the TS SDK for replicas
 * (`docs/contracts/replica-client-api.md`).
 */
export * from "./cbor.js";
export { SchemaError } from "./codec.js";
export type { Codec } from "./codec.js";
export type { AttachmentContentV1, AttachmentRefV1 } from "./attachment-wire.js";
export * from "./errors.js";
export * as wire from "./wire.js";
export { DESCRIBE_TYPING_MAX_PATHS, DESCRIBE_TYPING_MAX_TYPES, TEMPORAL_HINTS } from "./wire.js";
export type {
  AppliedPrefix,
  AppliedPrefixParams,
  AttachmentHoldContent,
  BlobRef,
  Change,
  ConfirmedHead,
  Conflict,
  ConflictEntry,
  ConflictValue,
  FileView,
  GrantInfo,
  HelloResult,
  Hold,
  HoldReason,
  HoldResolution,
  Include,
  Incident,
  Issue,
  Materialization,
  Op,
  Peer,
  Problem,
  PublishState,
  QueryGroup,
  QueryMetadata,
  QueryResult,
  QueryUpdate,
  Receipt,
  RecordView,
  Recovery,
  Resyncing,
  ResyncPhase,
  SubmitParams,
  SyncStatus,
  TextOrBlob,
  TransferProgress,
  Uuid,
  Hash,
  Value,
  DescribeTypingResult,
  TemporalHint,
  TypingEntry,
} from "./wire.js";
export { connect, LiveQuery, MdbaseClient, Write } from "./client.js";
export type {
  ClientOptions,
  CreateInput,
  FenceHandler,
  LinkState,
  Query,
  PagesOptions,
  PagesReset,
  ChangesWatch,
  ChangesWatchState,
  RecordRef,
  UpdateInput,
  WriteOptions,
} from "./client.js";
export type { LiveQueryState } from "./live.js";
export { FilesApi, MAX_CONVENIENCE_BYTES } from "./files.js";
export type { FileRef, UploadOptions, UploadSource } from "./files.js";
export { PresenceApi } from "./presence.js";
export { TimersApi } from "./timers.js";
export type {
  AppTimersPort, DesiredTimer, Timer, TimerRequestOptions, TimerReconcileInput,
  TimerList, TimerReconciliation, TimerCancellation, TimerChannelRegistration,
  TimerOperationIdentity, TimerRecoverableReconcileInput, TimerOperationReceipt, TimerOperationLookup,
  WebPushChannelOptions, FcmChannelOptions,
} from "./timers.js";
export { Session, API_VERSIONS } from "./session.js";
export { framedPort, portPair, RecordReader } from "./transport/port.js";
export type { ByteChannel, Connector, FramePort, OpenedPort } from "./transport/port.js";
export { diffEdits, revisionOf, toPlain, toValue, uuidv7, valueEquals } from "./values.js";
export type { JsonLike, PlainValue } from "./values.js";
export { inProcessConnector } from "./transport/inprocess.js";
export type { InProcessConnectOptions, InProcessRuntime } from "./transport/inprocess.js";
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
export { ACCOUNT_KEY_STATES, DEVICE_KINDS, formatSas, approvalReadiness } from "./private.js";
export type { AccountKeyState, AccountKeyStatus, DeviceKind, PendingDevice, ApprovalReadiness, RecoveryKeyStatus } from "./private.js";
export { WasmRuntime } from "./runtime/wasm.js";
export type { OpenConfig, QueryExecutionProfile, RuntimeInfo } from "./runtime/wasm.js";
export { isConfirmed, summarizeStatus } from "./status.js";
export type { StatusKind, StatusSummary } from "./status.js";
export { pipeCloseError, relayPipeCarrier } from "./transport/relay-pipe.js";
export type { PipeAuth } from "./transport/relay-pipe.js";
export { controlRouteResolver, routeFromControl } from "./transport/control-route.js";
export type { ControlRouteOptions, ControlRouteResponse, ControlRouteTarget } from "./transport/control-route.js";
// The account-key (AK1) surface lives at `@mdbase-dev/sdk/account`: it carries Argon2id,
// Ed25519 and the strength meter, which the thin client does not need.
export { HOLD_COMPARE_SCHEME, HOLD_TITLE, describeHold, holdCompareLink, holdNotice, parseHoldCompareLink, syncStatusText } from "./holds.js";
export type { DescribeHoldOptions, HoldAction, HoldActionOption, HoldPresentation } from "./holds.js";
