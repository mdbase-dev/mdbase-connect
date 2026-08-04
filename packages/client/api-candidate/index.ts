/**
 * Phase 0 compile-only specification for the next public SDK.
 *
 * This module deliberately has no runtime implementation and is not a package
 * export. Consumer spikes compile against it before the public classes are
 * changed in the later SDK delivery slice.
 */
import type {
  CollectionChange,
  CollectionOperation,
  GrantScope,
  JsonObject,
  MdbaseAppManifest,
  MutationOperationIdentifier
} from "@mdbase-dev/connect-protocol";
import type {
  MdbaseApplicationSession as CurrentApplicationSession,
  MdbaseApplicationSessionOptions as CurrentSessionOptions,
  MdbaseApplicationSessionSnapshot
} from "../src/application-session.js";
import type { MdbaseConnection as CurrentConnection } from "../src/connection.js";
import type { MdbaseConnectionInfo, MdbaseConnectionRoute } from "../src/connection-types.js";
import type { MdbaseConnectOptions as CurrentConnectOptions } from "../src/connect-options.js";
import type { MdbaseFileClient as CurrentFiles } from "../src/files.js";
export { MdbaseBrowserSelection, MdbaseMemorySelection } from "../src/selection.js";
export type {
  MdbaseApplicationSelection,
  MdbaseBrowserSelectionOptions,
  MdbaseSelectionHistory
} from "../src/selection.js";
import type {
  AuthorizationProblemCode,
  CollectionChangesProblemCode,
  CollectionMutationProblemCode,
  ConnectOutcome,
  SessionProblemCode
} from "../src/outcomes.js";

export type * from "../src/outcomes.js";
export type * from "../src/operation-types.js";
export type * from "../src/connection-types.js";
export type * from "../src/files.js";
export type {
  MdbaseApplicationSessionSnapshot,
  MdbaseDefinitionUpdate,
  MdbaseApplicationSessionOptions,
  MdbaseApplicationVerificationStore
} from "../src/application-session.js";
export type {
  CollectionChange,
  CollectionOperation,
  GrantScope,
  JsonObject,
  MdbaseAppManifest,
  MutationOperationIdentifier
} from "@mdbase-dev/connect-protocol";

export interface ConnectRequestOptions {
  signal?: AbortSignal;
  /** Relative request budget; null deliberately disables the configured default. */
  timeoutMs?: number | null;
}

export interface MdbaseConnectTimeouts {
  requestMs?: number | null;
  watchStartMs?: number | null;
  uploadMs?: number | null;
  syncMs?: number | null;
}

export interface MdbaseConnectOptions extends Omit<
  CurrentConnectOptions,
  "serverUrl" | "manifest" | "redirectUri" | "loopbackUrl"
> {
  serverUrl: string | URL;
  manifest?: MdbaseAppManifest | string | URL;
  redirectUri?: string | URL;
  loopbackUrl?: string | URL;
  timeouts?: MdbaseConnectTimeouts;
}

export interface PendingMutation<Result = unknown> {
  readonly requestId: string;
  readonly operation: MutationOperationIdentifier;
  readonly fingerprint: string;
  readonly status: "pending" | "recovering" | "outcome_unknown";
  readonly createdAt: string;
  recover(options?: ConnectRequestOptions): Promise<ConnectOutcome<Result>>;
}

export interface WatchInput {
  cursor?: string;
  pollIntervalMs?: number;
  /** Cancels the subscription lifetime after startup has succeeded. */
  lifetimeSignal?: AbortSignal;
}

export type WatchStatus = "connected" | "reconnecting" | "closed";

export interface MdbaseWatchSubscription {
  readonly status: WatchStatus;
  subscribe(
    listener: (change: CollectionChange) => void,
    onStatus?: (status: WatchStatus) => void
  ): () => void;
  close(): void;
}

type Method<Owner, Key extends keyof Owner> = Extract<Owner[Key], (...args: never[]) => unknown>;
type FirstArgument<Owner, Key extends keyof Owner> = Parameters<Method<Owner, Key>>[0];
type ExistingResult<Owner, Key extends keyof Owner> = ReturnType<Method<Owner, Key>>;
type RawOutcome<Owner, Key extends keyof Owner> = Promise<ConnectOutcome<
  Awaited<ExistingResult<Owner, Key>>
>>;
type AsyncItem<Value> = Value extends AsyncGenerator<infer Item, unknown, unknown> ? Item : never;
type Current<Frontmatter extends JsonObject> = CurrentConnection<Frontmatter>;
type CurrentSync<Frontmatter extends JsonObject> = NonNullable<ReturnType<Current<Frontmatter>["sync"]>>;

export interface MdbaseFiles {
  list(options?: ConnectRequestOptions & FirstArgument<CurrentFiles, "list">): AsyncGenerator<
    ConnectOutcome<AsyncItem<ReturnType<CurrentFiles["list"]>>>
  >;
  upload(
    path: Parameters<CurrentFiles["upload"]>[0],
    source: Parameters<CurrentFiles["upload"]>[1],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["upload"]>[2]>
  ): RawOutcome<CurrentFiles, "upload">;
  uploadStream(
    path: Parameters<CurrentFiles["uploadStream"]>[0],
    source: Parameters<CurrentFiles["uploadStream"]>[1],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["uploadStream"]>[2]>
  ): RawOutcome<CurrentFiles, "uploadStream">;
  download(
    file: Parameters<CurrentFiles["download"]>[0],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["download"]>[1]>
  ): RawOutcome<CurrentFiles, "download">;
  downloadStream(
    file: Parameters<CurrentFiles["downloadStream"]>[0],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["downloadStream"]>[1]>
  ): RawOutcome<CurrentFiles, "downloadStream">;
  downloadBytes(
    file: Parameters<CurrentFiles["downloadBytes"]>[0],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["downloadBytes"]>[1]>
  ): RawOutcome<CurrentFiles, "downloadBytes">;
  move(
    file: Parameters<CurrentFiles["move"]>[0],
    path: Parameters<CurrentFiles["move"]>[1],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["move"]>[2]>
  ): RawOutcome<CurrentFiles, "move">;
  delete(
    file: Parameters<CurrentFiles["delete"]>[0],
    options?: ConnectRequestOptions & NonNullable<Parameters<CurrentFiles["delete"]>[1]>
  ): RawOutcome<CurrentFiles, "delete">;
}

export interface MdbaseConnection<Frontmatter extends JsonObject = JsonObject> {
  readonly collectionId: string;
  readonly displayName: string;
  readonly operations: CollectionOperation[];
  readonly scope: GrantScope | null;
  readonly route: MdbaseConnectionRoute;
  readonly files: MdbaseFiles;
  info(): MdbaseConnectionInfo | null;
  describe(options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "describe">;
  changes(input?: FirstArgument<Current<Frontmatter>, "changes">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "changes">;
  read(input: FirstArgument<Current<Frontmatter>, "read">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "read">;
  query(input?: FirstArgument<Current<Frontmatter>, "query">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "query">;
  queryPages(input?: FirstArgument<Current<Frontmatter>, "queryPages">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "queryPages">;
  queryAll(input?: FirstArgument<Current<Frontmatter>, "queryAll">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "queryAll">;
  listViews(options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "listViews">;
  executeView(input: FirstArgument<Current<Frontmatter>, "executeView">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "executeView">;
  readViewSource(input: FirstArgument<Current<Frontmatter>, "readViewSource">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "readViewSource">;
  createViewSource(input: FirstArgument<Current<Frontmatter>, "createViewSource">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "createViewSource">;
  updateViewSource(input: FirstArgument<Current<Frontmatter>, "updateViewSource">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "updateViewSource">;
  deleteViewSource(input: FirstArgument<Current<Frontmatter>, "deleteViewSource">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "deleteViewSource">;
  create(input: FirstArgument<Current<Frontmatter>, "create">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "create">;
  update(input: FirstArgument<Current<Frontmatter>, "update">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "update">;
  delete(input: FirstArgument<Current<Frontmatter>, "delete">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "delete">;
  preflightDelete(input: FirstArgument<Current<Frontmatter>, "preflightDelete">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "preflightDelete">;
  rename(input: FirstArgument<Current<Frontmatter>, "rename">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "rename">;
  preflightRename(input: FirstArgument<Current<Frontmatter>, "preflightRename">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "preflightRename">;
  validate(input?: FirstArgument<Current<Frontmatter>, "validate">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "validate">;
  readType(input: FirstArgument<Current<Frontmatter>, "readType">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "readType">;
  createType(input: FirstArgument<Current<Frontmatter>, "createType">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "createType">;
  updateType(input: FirstArgument<Current<Frontmatter>, "updateType">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "updateType">;
  assessTypePack(input: FirstArgument<Current<Frontmatter>, "assessTypePack">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "assessTypePack">;
  applyTypePack(input: FirstArgument<Current<Frontmatter>, "applyTypePack">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "applyTypePack">;
  listTimers(namespace: string, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "listTimers">;
  putTimer(input: FirstArgument<Current<Frontmatter>, "putTimer">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "putTimer">;
  cancelTimer(input: FirstArgument<Current<Frontmatter>, "cancelTimer">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "cancelTimer">;
  reconcileTimers(input: FirstArgument<Current<Frontmatter>, "reconcileTimers">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "reconcileTimers">;
  watch(input?: WatchInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseWatchSubscription, CollectionChangesProblemCode>>;
  pendingMutations(): readonly PendingMutation[];
  pendingMutation(requestId: string): PendingMutation | null;
  sync(): MdbaseSyncConnection<Frontmatter> | null;
  registerNotifications(input: FirstArgument<Current<Frontmatter>, "registerNotifications">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "registerNotifications">;
  registerNativeNotifications(input: FirstArgument<Current<Frontmatter>, "registerNativeNotifications">, options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "registerNativeNotifications">;
  unregisterNativeNotifications(options?: ConnectRequestOptions): ExistingResult<Current<Frontmatter>, "unregisterNativeNotifications">;
  authorize(
    options?: ConnectRequestOptions & FirstArgument<Current<Frontmatter>, "authorize">
  ): ExistingResult<Current<Frontmatter>, "authorize">;
  forget(): void;
}

export interface MdbaseSyncConnection<Frontmatter extends JsonObject = JsonObject> {
  readonly collectionId: string;
  readonly replicaId: string;
  readonly transport: {
    openSession(options?: ConnectRequestOptions): ReturnType<CurrentSync<Frontmatter>["transport"]["openSession"]>;
    snapshot(
      snapshotId: Parameters<CurrentSync<Frontmatter>["transport"]["snapshot"]>[0],
      page?: Parameters<CurrentSync<Frontmatter>["transport"]["snapshot"]>[1],
      options?: ConnectRequestOptions
    ): ReturnType<CurrentSync<Frontmatter>["transport"]["snapshot"]>;
    changes(
      after: Parameters<CurrentSync<Frontmatter>["transport"]["changes"]>[0],
      limit?: Parameters<CurrentSync<Frontmatter>["transport"]["changes"]>[1],
      options?: ConnectRequestOptions
    ): ReturnType<CurrentSync<Frontmatter>["transport"]["changes"]>;
    mutate(
      mutation: Parameters<CurrentSync<Frontmatter>["transport"]["mutate"]>[0],
      options?: ConnectRequestOptions
    ): ReturnType<CurrentSync<Frontmatter>["transport"]["mutate"]>;
  };
}

export interface MdbaseApplicationSession<Frontmatter extends JsonObject = JsonObject> {
  start(options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>>;
  destroy(): void;
  getSnapshot(): MdbaseApplicationSessionSnapshot;
  subscribe(listener: () => void): () => void;
  connection(): MdbaseConnection<Frontmatter> | null;
  authorize(target: "choose" | "selected" | { collectionId: string }, options?: ConnectRequestOptions): Promise<ConnectOutcome<unknown, SessionProblemCode>>;
  completeAuthorization(callbackUrl?: string | URL, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, AuthorizationProblemCode>>;
  applyDefinitionUpdates(options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot>>;
  select(collectionId: string): void;
  clearSelection(): void;
  forget(collectionId: string): void;
}

export interface MdbaseExternalStore<Snapshot> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Snapshot;
}

export function externalStore(
  session: MdbaseApplicationSession
): MdbaseExternalStore<MdbaseApplicationSessionSnapshot> {
  return session;
}

export declare class MdbaseConnect<Frontmatter extends JsonObject = JsonObject> {
  constructor(options: MdbaseConnectOptions);
  application(options: CurrentSessionOptions): MdbaseApplicationSession<Frontmatter>;
  connections(): MdbaseConnectionInfo[];
  connection(collectionId: string): MdbaseConnection<Frontmatter> | null;
  forgetAll(): void;
}

/** Compile-only helper ensuring pending results retain the mutation problem union. */
export type MutationOutcome<Result> = ConnectOutcome<Result, CollectionMutationProblemCode>;
