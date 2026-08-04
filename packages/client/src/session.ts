import type {
  CollectionOperation,
  JsonObject
} from "@mdbase-dev/connect-protocol";
import {
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
import { connectProblem } from "./errors.js";
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

export type MdbaseUnavailableReason =
  | "not_authorized"
  | "authorization_lost"
  | "invalid_stored_grant";

export type MdbaseSessionSnapshot<Frontmatter extends JsonObject = JsonObject> =
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
  private refreshing = false;
  private refreshQueued = false;
  private transactionDepth = 0;
  private callbackPromise: Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, AuthorizationProblemCode>> | null = null;

  constructor(
    private readonly connect: MdbaseSessionConnect<Frontmatter>,
    options: MdbaseSessionOptions
  ) {
    this.operations = uniqueOperations(options.operations ?? DEFAULT_OPERATIONS);
    this.selection = options.selection;
    this.autoSelect = options.autoSelect ?? "only";
    this.snapshot = { status: "unselected", connections: [] };
    this.refresh();
  }

  async start(options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseSessionSnapshot<Frontmatter>, SessionProblemCode>> {
    if (!this.started) {
      this.started = true;
      this.stopConnections = this.connect.onConnectionsChange(() => this.refresh());
      this.stopSelection = this.selection.subscribe(() => {
        this.unavailableReason = "not_authorized";
        this.refresh();
      });
    }
    const callback = this.selection.authorizationCallback();
    if (callback) {
      const completed = await this.handleAuthorizationCallback(callback, options);
      if (!completed.ok) return completed;
    }
    else this.autoSelectOnlyConnection();
    this.refresh();
    return connectSuccess(this.snapshot);
  }

  destroy(): void {
    this.stopConnections?.();
    this.stopSelection?.();
    this.stopActiveConnection?.();
    this.stopConnections = undefined;
    this.stopSelection = undefined;
    this.stopActiveConnection = undefined;
    this.activeCollectionId = null;
    this.started = false;
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
  ): ConnectOutcome<MdbaseConnection<Frontmatter>, "unknown_collection"> {
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

  clearSelection(options: { history?: MdbaseSelectionHistory } = {}): void {
    this.unavailableReason = "not_authorized";
    this.selection.select(null, options);
    this.refresh();
  }

  forget(collectionId: string): void {
    this.transactionDepth += 1;
    try {
      const selected = this.selection.selectedCollectionId() === collectionId;
      this.connect.connection(collectionId)?.forget();
      if (selected) this.selection.select(null, { history: "replace" });
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  async authorize(
    target: "choose" | "selected" | { collectionId: string },
    options: Omit<MdbaseAuthorizeOptions, "operations" | "returnTo" | "target"> = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, SessionProblemCode>> {
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
    this.transactionDepth += 1;
    try {
      const outcome = await this.connect.authorize({
        ...options,
        operations: this.operations,
        target: targetCollectionId === null
          ? { kind: "choose" }
          : { kind: "collection", collectionId: targetCollectionId },
        returnTo: this.selection.authorizationReturnTo()
      });
      if (outcome.ok && outcome.value.kind === "connected") {
        this.selection.finishAuthorization(
          outcome.value.returnTo,
          outcome.value.connection.collectionId
        );
      }
      return outcome;
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  async ensureOperations(
    requiredOperations: CollectionOperation[]
  ): Promise<ConnectOutcome<
    MdbaseAuthorizationOutcome<Frontmatter>
    | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> },
    SessionProblemCode
  >> {
    const current = this.snapshot;
    if (current.status !== "ready") {
      return connectFailure(connectProblem(
        "collection_not_ready",
        "Choose an authorized collection first."
      ));
    }
    const required = uniqueOperations(requiredOperations);
    const capabilities = current.connection.authorizationCapabilities(required);
    if (capabilities.sufficient) {
      return connectSuccess({ kind: "unchanged", connection: current.connection });
    }
    this.transactionDepth += 1;
    try {
      const outcome = await this.connect.authorize({
        operations: uniqueOperations([...capabilities.grantedOperations, ...capabilities.missingOperations]),
        target: { kind: "collection", collectionId: current.collectionId },
        returnTo: this.selection.authorizationReturnTo()
      });
      if (outcome.ok && outcome.value.kind === "connected") {
        this.selection.finishAuthorization(
          outcome.value.returnTo,
          outcome.value.connection.collectionId
        );
      }
      return outcome;
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  handleAuthorizationCallback(
    callbackUrl: string,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, AuthorizationProblemCode>> {
    if (!isAuthorizationCallbackUrl(callbackUrl)) {
      return Promise.resolve(connectFailure(connectProblem(
        "invalid_callback",
        "This URL is not an authorization callback."
      )));
    }
    if (this.callbackPromise) return this.callbackPromise;
    this.transactionDepth += 1;
    const completion = this.connect.completeAuthorization(callbackUrl, options)
      .then((outcome) => {
        if (!outcome.ok) {
          const returnTo = authorizationReturnToFromProblem(outcome.problem);
          this.selection.clearAuthorizationCallback(returnTo);
          this.refresh();
          return outcome;
        }
        const result = outcome.value;
        this.unavailableReason = "not_authorized";
        this.selection.finishAuthorization(result.returnTo, result.connection.collectionId);
        this.refresh();
        return connectSuccess(result.connection, outcome.diagnostics);
      })
      .catch((error: unknown) => {
        this.selection.clearAuthorizationCallback();
        this.refresh();
        throw error;
      })
      .finally(() => {
        this.transactionDepth -= 1;
        this.refresh();
        if (this.callbackPromise === completion) this.callbackPromise = null;
      });
    this.callbackPromise = completion;
    return completion;
  }

  private autoSelectOnlyConnection(): void {
    if (this.autoSelect !== "only" || this.selection.selectedCollectionId()) return;
    const connections = this.connect.connections();
    if (connections.length === 1) {
      this.selection.select(connections[0].collectionId, { history: "replace" });
    }
  }

  private refresh(): void {
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
        this.refreshOnce();
      } while (this.refreshQueued);
    } finally {
      this.refreshing = false;
    }
  }

  private refreshOnce(): void {
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
    const key = sessionSnapshotKey(next);
    if (key === this.snapshotKey) return;
    this.snapshot = next;
    this.snapshotKey = key;
    for (const listener of this.listeners) listener();
  }
}

function sessionSnapshotKey<Frontmatter extends JsonObject>(
  snapshot: MdbaseSessionSnapshot<Frontmatter>
): string {
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
