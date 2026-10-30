/**
 * @mdbase-dev/sdk/thin-client: the replica thin client for consumers that bring
 * their own connection, such as an Obsidian-plugin-style integration: codec,
 * client, records, files, presence, Noise and relay transports, keys, status and
 * collection availability. It is held to the thin-client size ceiling
 * (scripts/size.mjs) and never bundles manifest validation.
 *
 * The root entry re-exports all of this and adds the application entry
 * (`MdbaseConnect`), people, timers, notifications, holds, `describeError`,
 * `WasmRuntime` and `inProcessConnector`.
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
  FileContentProfile,
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
export type {RecordValidation, ValidationIssue} from "./validation.js";
export { connect, LiveQuery, MdbaseClient, Write } from "./client.js";
export type {
  ClientOptions,
  SaveResult,
  CreateInput,
  FenceHandler,
  LinkState,
  Query,
  PagesOptions,
  PagesReset,
  ChangesWatch,
  ChangesWatchState,
  RecordRef,
  RecordWrite,
  UpdateInput,
  WriteOptions,
} from "./client.js";
export type { DescribeOptions, TypeCreation } from "./client.js";
export type {RecordLease, RecordOpenOptions, RecordSession, RecordSessionSnapshot, RecordSessionState, RecordRecovery, RecordRecoveryRef, RecordResolution, RecordFlushOptions, RecordFlushResult, Records} from "./records.js";
export {readMany, queryPages, resolveRecordLinks, READ_MANY_MAX_REFS, READ_MANY_MAX_CONCURRENCY} from "./read-helpers.js";
export type {ReadManyOptions} from "./read-helpers.js";
export {createViewSource, updateViewSource, readViewSourceRecord} from "./view-sources.js";
export type {ViewSourceCreateInput, ViewSourceWriteOptions, ViewSourceReadOptions} from "./view-sources.js";
export type {ListViewsResult, ExecuteViewOptions} from "./saved-views.js";
export type { LiveQueryState } from "./live.js";
export { FilesApi, MAX_CONVENIENCE_BYTES } from "./files.js";
export type { FileRef, FileWrite, UploadOptions, UploadSource } from "./files.js";
export { fileGrant } from "./files.js";
export type { FileAction, FileGrant, FileScope } from "./files.js";
export { PresenceApi } from "./presence.js";
export type { ContractRef, ContractProjection, ContractQueryRecord, ContractQueryResult, ContractQueryOptions } from "./contract-query.js";
export type { ContractSelector, ContractIdentity, ContractRecordView } from "./contract-records.js";
export type {
  TypePackAction, TypePackApplyResult, TypePackConflict, TypePackOptions, TypePackPlan, TypePackProvision,
  TypePackReceipt, TypePackRefusalCode, TypePackResource, TypePackResourceKind, TypePackStatus,
} from "./type-packs.js";
export { Session, API_VERSIONS } from "./session.js";
export { framedPort, portPair, RecordReader } from "./transport/port.js";
export type { ByteChannel, Connector, FramePort, OpenedPort } from "./transport/port.js";
export { diffEdits, revisionOf, toPlain, toValue, uuidv7, valueEquals } from "./values.js";
export type { JsonLike, PlainValue } from "./values.js";
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
export { isConfirmed, summarizeStatus } from "./status.js";
export type { StatusKind, StatusSummary, TransportHealth, TransportHealthKind } from "./status.js";
export { memoryWriteLedgerStore } from "./write-ledger.js";
export type { SaveState, WriteLedgerEntry, WriteLedgerSnapshot, WriteLedgerStore, WriteLedgerView } from "./write-ledger.js";
export { pipeCloseError, relayPipeCarrier } from "./transport/relay-pipe.js";
export type { PipeAuth } from "./transport/relay-pipe.js";
export { controlRouteResolver, routeFromControl } from "./transport/control-route.js";
export type { ControlRouteOptions, ControlRouteResponse, ControlRouteTarget } from "./transport/control-route.js";
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
