/**
 * What an app does with a collection once it has one: the client, records,
 * files, contracts, values, errors and status. Both the root entry and
 * `./thin-client` export all of it; neither adds to it here. How a collection
 * is reached (transports, keys, the wire encoding) is not part of it.
 */
export * from "./errors.js";
export * as wire from "./wire.js";
export { DESCRIBE_TYPING_MAX_PATHS, DESCRIBE_TYPING_MAX_TYPES, TEMPORAL_HINTS } from "./wire.js";
export type {
  AppliedPrefix,
  AttachmentHoldContent,
  BlobRef,
  Change,
  ConfirmedHead,
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
  Problem,
  PublishState,
  Recovery,
  Resyncing,
  ResyncPhase,
  SyncStatus,
  TextOrBlob,
  TransferProgress,
  ValidationLevel,
  Uuid,
  Hash,
  Value,
  DescribeTypingResult,
  TemporalHint,
  TypingEntry,
} from "./wire.js";
export type {RecordValidation, ValidationIssue} from "./validation.js";
export { LiveQuery, MdbaseClient, Write } from "./client.js";
export type {
  CreateInput,
  FenceHandler,
  LinkState,
  Query,
  PagesOptions,
  PagesReset,
  ChangesWatch,
  ChangesWatchState,
  ReadOptions,
  RecordReadOptions,
  RecordRef,
  RecordWrite,
  UpdateInput,
  WriteOptions,
} from "./client.js";
export type { DescribeOptions, TypeCreation } from "./client.js";
export type { Settlement, SettleOptions, SettleRead } from "./settle.js";
export { isProtected } from "./records/witness.js";
export type {RecordLease, RecordOpenOptions, RecordSession, RecordSessionSnapshot, RecordSessionState, RecordRecovery, RecordRecoveryRef, RecordResolution, RecordFlushOptions, RecordFlushResult, Records} from "./records.js";
export {readMany, queryPages, resolveRecordLinks, READ_MANY_MAX_REFS, READ_MANY_MAX_CONCURRENCY} from "./read-helpers.js";
export type {ReadManyOptions} from "./read-helpers.js";
export {createViewSource, updateViewSource, readViewSourceRecord} from "./view-sources.js";
export type {ViewSourceCreateInput, ViewSourceWriteOptions, ViewSourceReadOptions} from "./view-sources.js";
export type {ListViewsResult, ExecuteViewOptions} from "./saved-views.js";
export type { LiveQueryState } from "./live.js";
export { RecordSet } from "./record-set.js";
export type { RecordSetChange, RecordSetListener, RecordSetOptions, RecordSetSnapshot, RecordSetState } from "./record-set.js";
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
// The exact forms a write accepts and a `wire` codec decodes.
export { Float64 } from "./cbor.js";
export type { CborMap, CborValue } from "./cbor.js";
export { diffEdits, revisionOf, toPlain, toValue, uuidv7, valueEquals } from "./values.js";
export type { JsonObject, JsonValue, PlainValue } from "./values.js";
// What a client method answers: values as plain JSON, data maps as objects.
// The same names under `wire` are the exact forms the wire codecs decode.
export type {
  Backlink,
  BacklinksResult,
  Conflict,
  ConflictEntry,
  ConflictValue,
  ContractImplementation,
  ContractSummary,
  DescribeResult,
  Peer,
  PendingMutation,
  Plain,
  QueryGroup,
  QueryMetadata,
  QueryResult,
  QueryUpdate,
  Receipt,
  RecordView,
  TypeSummary,
  ViewDescriptor,
  ViewSource,
} from "./plain.js";
export { ACCOUNT_KEY_STATES, DEVICE_KINDS, formatSas, approvalReadiness } from "./private.js";
export type { AccountKeyState, AccountKeyStatus, DeviceKind, PendingDevice, ApprovalReadiness, RecoveryKeyStatus } from "./private.js";
export { isConfirmed, summarizeSync } from "./status.js";
export type { MdbaseSync, SyncAttention, SyncInput, SyncState, TransportHealth, TransportHealthKind } from "./status.js";
export { memoryWriteLedgerStore } from "./write-ledger.js";
export type { SaveState, WriteLedgerEntry, WriteLedgerSnapshot, WriteLedgerStore, WriteLedgerView } from "./write-ledger.js";
