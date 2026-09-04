import type {
  ApplicationCapabilityId,
  CollectionOperation,
  ConnectProblem,
  ConnectProblemCode,
  JsonObject
} from "@mdbase-dev/connect-protocol";
import { capabilityOperations } from "@mdbase-dev/connect-protocol";
import {
  authorizationCallbackState,
  authorizationReturnToFromProblem,
  isAuthorizationCallbackUrl
} from "./authorization-url.js";
import {
  MdbaseConnection,
  type MdbaseAuthorizationOutcome,
  type MdbaseAuthorizationResult,
  type MdbaseAuthorizeOptions
} from "./connection.js";
import type {
  MdbaseAuthorizationCapabilities,
  MdbaseConnectionInfo
} from "./connection-types.js";
import { MdbaseConnectError, connectProblem } from "./errors.js";
import { DEFAULT_OPERATIONS } from "./internal-types.js";
import { uniqueOperations } from "./operation-helpers.js";
import {
  connectFailure,
  connectSuccess,
  type AuthorizationProblemCode,
  type ConnectOutcome,
  type SessionProblemCode
} from "./outcomes.js";
import type {
  MdbaseSelectionHistory,
  MdbaseApplicationSelection
} from "./selection.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  requestAbortReason,
  withRequestBudget
} from "./request-budget.js";

export interface MdbaseSessionConnect<Frontmatter extends JsonObject> {
  authorize(
    options?: MdbaseAuthorizeOptions
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, AuthorizationProblemCode>>;
  completeAuthorization(
    callbackUrl: string,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseAuthorizationResult<Frontmatter>, AuthorizationProblemCode>>;
  connections(): MdbaseConnectionInfo[];
  connection(collectionId: string): MdbaseConnection<Frontmatter> | null;
  unavailableReason(collectionId: string): MdbaseUnavailableReason | null;
  onConnectionsChange(
    listener: (connections: MdbaseConnectionInfo[]) => void
  ): () => void;
}

export interface MdbaseSessionOptions {
  selection: MdbaseApplicationSelection;
  operations?: CollectionOperation[];
  autoSelect?: "only" | "never";
}

interface CallbackCompletion<Frontmatter extends JsonObject> {
  state: string;
  promise: Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode>>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  abandoned: boolean;
}

export type MdbaseUnavailableReason =
  | "not_authorized"
  | "authorization_lost"
  | "invalid_stored_grant"
  | "legacy_scope_reauthorization_required";

export type MdbaseSessionSnapshot<Frontmatter extends JsonObject = JsonObject> =
  | { status: "not_started"; connections: MdbaseConnectionInfo[] }
  | { status: "starting"; connections: MdbaseConnectionInfo[] }
  | {
      status: "start_failed";
      problem: ConnectProblem<SessionProblemCode>;
      connections: MdbaseConnectionInfo[];
    }
  | { status: "destroyed"; connections: MdbaseConnectionInfo[] }
  | {
      status: "unselected";
      connections: MdbaseConnectionInfo[];
    }
  | {
      status: "ready";
      collectionId: string;
      connection: MdbaseConnection<Frontmatter>;
      info: MdbaseConnectionInfo;
      access: MdbaseAuthorizationCapabilities;
      connections: MdbaseConnectionInfo[];
    }
  | {
      status: "unavailable";
      collectionId: string;
      reason: MdbaseUnavailableReason;
      connections: MdbaseConnectionInfo[];
    };

export class MdbaseSession<Frontmatter extends JsonObject = JsonObject> {
  private readonly operations: CollectionOperation[];
  private readonly selection: MdbaseApplicationSelection;
  private readonly autoSelect: "only" | "never";
  private readonly listeners = new Set<() => void>();
  private snapshot: MdbaseSessionSnapshot<Frontmatter>;
  private snapshotKey = "";
  private stopConnections?: () => void;
  private stopSelection?: () => void;
  private stopActiveConnection?: () => void;
  private activeCollectionId: string | null = null;
  private unavailableReason: MdbaseUnavailableReason = "not_authorized";
  private started = false;
  private destroyed = false;
  private refreshing = false;
  private refreshQueued = false;
  private transactionDepth = 0;
  private lifecycleGeneration = 0;
  private readonly operationControllers = new Set<AbortController>();
  private startOperation: {
    promise: Promise<ConnectOutcome<MdbaseSessionSnapshot<Frontmatter>, SessionProblemCode>>;
    controller: AbortController;
    waiters: number;
    generation: number;
  } | null = null;
  private readonly callbackCompletions = new Map<string, CallbackCompletion<Frontmatter>>();

  constructor(
    private readonly connect: MdbaseSessionConnect<Frontmatter>,
    options: MdbaseSessionOptions
  ) {
    this.operations = uniqueOperations(options.operations ?? DEFAULT_OPERATIONS);
    this.selection = options.selection;
    this.autoSelect = options.autoSelect ?? "only";
    this.snapshot = { status: "not_started", connections: [] };
  }

  start(options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseSessionSnapshot<Frontmatter>, SessionProblemCode>> {
    if (this.destroyed) {
      return Promise.resolve(connectFailure(connectProblem("session_destroyed", "This session has been destroyed.")));
    }
    if (this.started && !this.startOperation) {
      return Promise.resolve(connectSuccess(this.snapshot));
    }
    const operation = this.startOperation ?? this.beginStart();
    return this.waitForStart(operation, options);
  }

  private beginStart(): NonNullable<MdbaseSession<Frontmatter>["startOperation"]> {
    const controller = new AbortController();
    const generation = ++this.lifecycleGeneration;
    this.publish({ status: "starting", connections: this.connect.connections() });
    const operation = {
      promise: this.performStart({ signal: controller.signal, timeoutMs: null }, generation),
      controller,
      waiters: 0,
      generation
    };
    this.startOperation = operation;
    const settled = () => {
      if (this.startOperation === operation) this.startOperation = null;
    };
    operation.promise.then(settled, settled);
    return operation;
  }

  private async waitForStart(
    operation: NonNullable<MdbaseSession<Frontmatter>["startOperation"]>,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseSessionSnapshot<Frontmatter>, SessionProblemCode>> {
    operation.waiters += 1;
    try {
      return await withRequestBudget(options, DEFAULT_STARTUP_TIMEOUT_MS, () => operation.promise);
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem as ConnectProblem<SessionProblemCode>);
      }
      throw error;
    } finally {
      operation.waiters -= 1;
      if (operation.waiters === 0 && this.startOperation === operation) {
        operation.controller.abort();
        this.startOperation = null;
        this.lifecycleGeneration += 1;
        this.stopLifecycleSubscriptions();
        this.started = false;
        this.publish({ status: "not_started", connections: this.connect.connections() });
      }
    }
  }

  private async performStart(
    options: ConnectRequestOptions,
    generation: number
  ): Promise<ConnectOutcome<MdbaseSessionSnapshot<Frontmatter>, SessionProblemCode>> {
    try {
      this.started = true;
      this.stopConnections = this.connect.onConnectionsChange(() => this.refresh());
      this.stopSelection = this.selection.subscribe(() => {
        this.unavailableReason = "not_authorized";
        this.refresh();
      });
      const callback = this.selection.authorizationCallback();
      if (callback) {
        const completed = await this.completeAuthorizationCallback(callback, options);
        if (!completed.ok) {
          if (generation === this.lifecycleGeneration && !this.destroyed) {
            this.stopLifecycleSubscriptions();
            this.started = false;
            this.publish({
              status: "start_failed",
              problem: completed.problem,
              connections: this.connect.connections()
            });
          }
          return completed;
        }
      }
      else this.autoSelectOnlyConnection();
      if (generation !== this.lifecycleGeneration || this.destroyed) {
        return connectFailure(connectProblem("session_destroyed", "This session has been destroyed."));
      }
      this.publishCurrent();
      return connectSuccess(this.snapshot);
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        const problem = error.problem as ConnectProblem<SessionProblemCode>;
        if (generation === this.lifecycleGeneration && !this.destroyed) {
          this.stopLifecycleSubscriptions();
          this.started = false;
          this.publish({ status: "start_failed", problem, connections: this.connect.connections() });
        }
        return connectFailure(problem);
      }
      if (generation === this.lifecycleGeneration && !this.destroyed) {
        this.stopLifecycleSubscriptions();
        this.started = false;
        this.publish({ status: "not_started", connections: this.connect.connections() });
      }
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.lifecycleGeneration += 1;
    this.startOperation?.controller.abort();
    this.startOperation = null;
    for (const controller of this.operationControllers) controller.abort();
    this.operationControllers.clear();
    this.stopLifecycleSubscriptions();
    this.started = false;
    this.destroyed = true;
    this.callbackCompletions.clear();
    this.publish({ status: "destroyed", connections: [] });
    this.listeners.clear();
  }

  private stopLifecycleSubscriptions(): void {
    this.stopConnections?.();
    this.stopSelection?.();
    this.stopActiveConnection?.();
    this.stopConnections = undefined;
    this.stopSelection = undefined;
    this.stopActiveConnection = undefined;
    this.activeCollectionId = null;
  }

  getSnapshot(): MdbaseSessionSnapshot<Frontmatter> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(
    collectionId: string,
    options: { history?: MdbaseSelectionHistory } = {}
  ): ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode> {
    const lifecycle = this.lifecycleProblem();
    if (lifecycle) return connectFailure(lifecycle);
    const connection = this.connect.connection(collectionId);
    if (!connection) {
      return connectFailure(connectProblem(
        "unknown_collection",
        "This collection is not authorized for this application."
      ));
    }
    this.unavailableReason = "not_authorized";
    this.selection.select(collectionId, options);
    this.refresh();
    return connectSuccess(connection);
  }

  clearSelection(options: { history?: MdbaseSelectionHistory } = {}): ConnectOutcome<void, SessionProblemCode> {
    const lifecycle = this.lifecycleProblem();
    if (lifecycle) return connectFailure(lifecycle);
    this.unavailableReason = "not_authorized";
    this.selection.select(null, options);
    this.refresh();
    return connectSuccess(undefined);
  }

  forget(collectionId: string): ConnectOutcome<void, SessionProblemCode> {
    const lifecycle = this.lifecycleProblem();
    if (lifecycle) return connectFailure(lifecycle);
    this.transactionDepth += 1;
    try {
      const selected = this.selection.selectedCollectionId() === collectionId;
      this.connect.connection(collectionId)?.forget();
      if (selected) this.selection.select(null, { history: "replace" });
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
    return connectSuccess(undefined);
  }

  async authorize(
    target: "choose" | "selected" | { collectionId: string },
    options: Omit<MdbaseAuthorizeOptions, "returnTo" | "target"> = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, SessionProblemCode>> {
    const lifecycle = this.lifecycleProblem();
    if (lifecycle) return connectFailure(lifecycle);
    const selectedCollectionId = this.selection.selectedCollectionId();
    if (target === "selected" && !selectedCollectionId) {
      return connectFailure(connectProblem(
        "collection_not_selected",
        "Choose a collection before updating its access."
      ));
    }
    const targetCollectionId = typeof target === "object"
      ? target.collectionId
      : target === "selected"
        ? selectedCollectionId!
        : null;
    const operation = this.beginLifecycleOperation(options);
    this.transactionDepth += 1;
    try {
      const outcome = await this.connect.authorize({
        ...operation.options,
        target: targetCollectionId === null
          ? { kind: "choose" }
          : { kind: "collection", collectionId: targetCollectionId },
        returnTo: this.selection.authorizationReturnTo()
      });
      if (!this.lifecycleCurrent(operation.generation)) return this.destroyedOutcome(outcome);
      if (outcome.ok && outcome.value.kind === "connected") {
        this.selection.finishAuthorization(
          outcome.value.returnTo,
          outcome.value.connection.collectionId
        );
      }
      return outcome;
    } finally {
      operation.dispose();
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  async ensureCapabilities(
    requiredCapabilities: ApplicationCapabilityId[],
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<
    MdbaseAuthorizationOutcome<Frontmatter>
    | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> },
    SessionProblemCode
  >> {
    const lifecycle = this.lifecycleProblem();
    if (lifecycle) return connectFailure(lifecycle);
    const current = this.snapshot;
    if (current.status !== "ready") {
      return connectFailure(connectProblem(
        "collection_not_ready",
        "Choose an authorized collection first."
      ));
    }
    const requiredOperations = uniqueOperations(
      requiredCapabilities.flatMap((capability) => capabilityOperations(capability))
    );
    const authorization = current.connection.authorizationCapabilities(requiredOperations);
    if (authorization.sufficient) {
      return connectSuccess({ kind: "unchanged", connection: current.connection });
    }
    const operation = this.beginLifecycleOperation(options);
    this.transactionDepth += 1;
    try {
      const outcome = await this.connect.authorize({
        ...operation.options,
        capabilities: requiredCapabilities,
        target: { kind: "collection", collectionId: current.collectionId },
        returnTo: this.selection.authorizationReturnTo()
      });
      if (!this.lifecycleCurrent(operation.generation)) return this.destroyedOutcome(outcome);
      if (outcome.ok && outcome.value.kind === "connected") {
        this.selection.finishAuthorization(
          outcome.value.returnTo,
          outcome.value.connection.collectionId
        );
      }
      return outcome;
    } finally {
      operation.dispose();
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  handleAuthorizationCallback(
    callbackUrl: string,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode>> {
    const lifecycle = this.lifecycleProblem();
    if (lifecycle) return Promise.resolve(connectFailure(lifecycle));
    if (!isAuthorizationCallbackUrl(callbackUrl)) {
      return Promise.resolve(connectFailure(connectProblem(
        "invalid_callback",
        "This URL is not an authorization callback."
      )));
    }
    return this.completeAuthorizationCallback(callbackUrl, options);
  }

  private completeAuthorizationCallback(
    callbackUrl: string,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode>> {
    if (options?.signal?.aborted) {
      const error = requestAbortReason(options.signal) as MdbaseConnectError;
      return Promise.resolve(connectFailure(error.problem as ConnectProblem<SessionProblemCode>));
    }
    const state = authorizationCallbackState(callbackUrl);
    if (!state) {
      return Promise.resolve(connectFailure(connectProblem(
        "invalid_callback",
        "Authorization callback is missing its state."
      )));
    }
    const operation = this.callbackCompletions.get(state)
      ?? this.beginCallbackCompletion(callbackUrl, state);
    return this.waitForCallbackCompletion(operation, options);
  }

  private beginCallbackCompletion(callbackUrl: string, state: string) {
    const controller = new AbortController();
    const generation = this.lifecycleGeneration;
    this.transactionDepth += 1;
    this.operationControllers.add(controller);
    const operation: CallbackCompletion<Frontmatter> = {
      state,
      controller,
      waiters: 0,
      settled: false,
      abandoned: false,
      promise: undefined as never
    };
    const completion = this.connect.completeAuthorization(callbackUrl, {
      signal: controller.signal,
      timeoutMs: null
    }).catch((error: unknown) => {
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem as ConnectProblem<SessionProblemCode>);
      }
      throw error;
    });
    operation.promise = completion
      .then((outcome): ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode> => {
        if (generation !== this.lifecycleGeneration || this.destroyed) {
          return this.destroyedOutcome(outcome);
        }
        if (!outcome.ok) {
          if (!operation.abandoned && outcome.problem.recovery !== "retry") {
            const returnTo = authorizationReturnToFromProblem(outcome.problem);
            this.selection.clearAuthorizationCallback(returnTo);
          }
          this.refresh();
          return outcome;
        }
        const result = outcome.value;
        this.unavailableReason = "not_authorized";
        this.selection.finishAuthorization(result.returnTo, result.connection.collectionId);
        this.refresh();
        return connectSuccess(result.connection, outcome.diagnostics);
      })
      .catch((error: unknown): ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode> => {
        if (generation !== this.lifecycleGeneration || this.destroyed) {
          return connectFailure(connectProblem(
            "session_destroyed",
            "This session was destroyed before authorization completion finished."
          ));
        }
        if (!operation.abandoned) {
          this.selection.clearAuthorizationCallback();
          this.refresh();
        }
        throw error;
      })
      .finally(() => {
        operation.settled = true;
        this.operationControllers.delete(controller);
        this.transactionDepth -= 1;
        this.refresh();
        if (this.callbackCompletions.get(state) === operation) {
          this.callbackCompletions.delete(state);
        }
      });
    this.callbackCompletions.set(state, operation);
    return operation;
  }

  private async waitForCallbackCompletion(
    operation: CallbackCompletion<Frontmatter>,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode>> {
    operation.waiters += 1;
    try {
      return await withRequestBudget(options, DEFAULT_REQUEST_TIMEOUT_MS, () => operation.promise);
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem as ConnectProblem<SessionProblemCode>);
      }
      throw error;
    } finally {
      operation.waiters -= 1;
      if (operation.waiters === 0
          && !operation.settled
          && this.callbackCompletions.get(operation.state) === operation) {
        operation.abandoned = true;
        this.callbackCompletions.delete(operation.state);
        operation.controller.abort();
      }
    }
  }

  private lifecycleProblem() {
    if (this.destroyed) {
      return connectProblem("session_destroyed", "This session has been destroyed.");
    }
    if (this.snapshot.status === "starting") {
      return connectProblem("session_starting", "The session is still starting.");
    }
    if (this.snapshot.status === "start_failed") return this.snapshot.problem;
    if (!this.started) {
      return connectProblem("session_not_started", "Start the session before using it.");
    }
    return null;
  }

  private beginLifecycleOperation(options: ConnectRequestOptions = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    this.operationControllers.add(controller);
    return {
      generation: this.lifecycleGeneration,
      options: { ...options, signal: controller.signal },
      dispose: () => {
        options.signal?.removeEventListener("abort", abort);
        this.operationControllers.delete(controller);
      }
    };
  }

  private lifecycleCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.lifecycleGeneration;
  }

  private destroyedOutcome<Code extends ConnectProblemCode>(
    outcome: ConnectOutcome<unknown, Code>
  ): ConnectOutcome<never, Code | SessionProblemCode> {
    if (!outcome.ok && outcome.problem.code === "operation_outcome_unknown") return outcome;
    return connectFailure(connectProblem(
      "session_destroyed",
      "This session was destroyed before the operation finished."
    ) as ConnectProblem<Code | SessionProblemCode>);
  }

  private autoSelectOnlyConnection(): void {
    if (this.autoSelect !== "only" || this.selection.selectedCollectionId()) return;
    const connections = this.connect.connections();
    if (connections.length === 1) {
      this.selection.select(connections[0].collectionId, { history: "replace" });
    }
  }

  private refresh(): void {
    if (
      !this.started
      || this.destroyed
      || this.snapshot.status === "starting"
      || this.snapshot.status === "start_failed"
    ) return;
    if (this.transactionDepth > 0) {
      this.refreshQueued = true;
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        this.publishCurrent();
      } while (this.refreshQueued);
    } finally {
      this.refreshing = false;
    }
  }

  private publishCurrent(): void {
    const collectionId = this.selection.selectedCollectionId();
    const connections = this.connect.connections();
    const connection = collectionId ? this.connect.connection(collectionId) : null;
    if (connection?.collectionId !== this.activeCollectionId) {
      this.stopActiveConnection?.();
      this.activeCollectionId = connection?.collectionId ?? null;
      this.stopActiveConnection = connection?.onConnectionChange((info) => {
        if (!info && this.selection.selectedCollectionId() === connection.collectionId) {
          this.unavailableReason = "authorization_lost";
        }
        this.refresh();
      });
    }

    let next: MdbaseSessionSnapshot<Frontmatter>;
    if (!collectionId) {
      next = { status: "unselected", connections };
    } else if (!connection || !connection.info()) {
      next = {
        status: "unavailable",
        collectionId,
        reason: this.connect.unavailableReason(collectionId) ?? this.unavailableReason,
        connections
      };
    } else {
      const info = connection.info()!;
      next = {
        status: "ready",
        collectionId,
        connection,
        info,
        access: connection.authorizationCapabilities(this.operations),
        connections
      };
    }
    this.publish(next);
  }

  private publish(snapshot: MdbaseSessionSnapshot<Frontmatter>): void {
    if (this.snapshot.status === "destroyed" && snapshot.status !== "destroyed") return;
    const key = sessionSnapshotKey(snapshot);
    if (key === this.snapshotKey) return;
    this.snapshot = snapshot;
    this.snapshotKey = key;
    for (const listener of this.listeners) listener();
  }
}

function sessionSnapshotKey<Frontmatter extends JsonObject>(
  snapshot: MdbaseSessionSnapshot<Frontmatter>
): string {
  if (
    snapshot.status === "not_started"
    || snapshot.status === "starting"
    || snapshot.status === "destroyed"
  ) return JSON.stringify(snapshot);
  if (snapshot.status === "start_failed") {
    return JSON.stringify({ status: snapshot.status, problem: snapshot.problem, connections: snapshot.connections });
  }
  if (snapshot.status === "unselected") {
    return JSON.stringify({ status: snapshot.status, connections: snapshot.connections });
  }
  if (snapshot.status === "unavailable") {
    return JSON.stringify({
      status: snapshot.status,
      collectionId: snapshot.collectionId,
      reason: snapshot.reason,
      connections: snapshot.connections
    });
  }
  return JSON.stringify({
    status: snapshot.status,
    collectionId: snapshot.collectionId,
    info: snapshot.info,
    access: snapshot.access,
    connections: snapshot.connections
  });
}
