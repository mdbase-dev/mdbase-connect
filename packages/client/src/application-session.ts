import {
  capabilityOperations,
  operationsForApplicationCapabilities,
  type ApplicationCapabilityId,
  type ApplicationCapabilityRequirements,
  type JsonObject,
  type MdbaseAppManifest,
  type TypePackProvision
} from "@mdbase-dev/connect-protocol";
/* The versioned protocol package is the sole capability-to-operation compiler. */
import { effectiveCapabilities, type MdbaseEffectiveCapabilities } from "./capabilities.js";
import type {
  MdbaseAuthorizationOutcome,
  MdbaseAuthorizeOptions,
  MdbaseConnection
} from "./connection.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";
import { connectProblem } from "./errors.js";
import {
  connectFailure,
  connectSuccess,
  type ConnectOutcome,
  type CollectionTypeProblemCode,
  type AuthorizationProblemCode,
  type RegistrationProblemCode,
  type SessionProblemCode
} from "./outcomes.js";
import type { MdbaseApplicationSelection, MdbaseSelectionHistory } from "./selection.js";
import type {
  CollectionSetupAssessment,
  ConfigurationSetupAssessment,
  ConnectRequestOptions,
  TypePackAssessment
} from "./operation-types.js";
import {
  createRequestBudget,
  requestAbortReason,
  resolveConnectTimeouts,
  type ResolvedConnectTimeouts,
  withRequestBudget
} from "./request-budget.js";
import { defaultCallbackUrl } from "./runtime-utils.js";
import type { Application } from "./internal-types.js";
import {
  MdbaseSession,
  type MdbaseSessionConnect,
  type MdbaseUnavailableReason
} from "./session.js";

export interface MdbaseApplicationSessionConnect<Frontmatter extends JsonObject = JsonObject>
  extends MdbaseSessionConnect<Frontmatter> {
  register(options?: ConnectRequestOptions): Promise<ConnectOutcome<Application, RegistrationProblemCode>>;
  manifest(options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseAppManifest, RegistrationProblemCode>>;
}

export interface MdbaseApplicationSessionOptions {
  selection: MdbaseApplicationSelection;
  autoSelect?: "only" | "never";
  verificationStore?: MdbaseApplicationVerificationStore;
}

export interface MdbaseApplicationVerificationStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export class MdbaseMemoryVerificationStore implements MdbaseApplicationVerificationStore {
  private readonly values = new Map<string, string>();

  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.values.set(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

export interface MdbaseDefinitionUpdate {
  id: string;
  name: string;
  status: TypePackAssessment["status"];
  applicable: boolean;
  assessmentDigest: string;
  currentVersion?: string;
  desiredVersion: string;
  resources: TypePackAssessment["resources"];
  contractSetups: TypePackAssessment["contractSetups"];
  canApply: boolean;
  reason: string;
}

export interface MdbaseCollectionSetupUpdate {
  status: CollectionSetupAssessment["status"];
  applicable: boolean;
  assessmentDigest: string;
  collectionRevision: string;
  provisionDigest: string;
  configuration: ConfigurationSetupAssessment[];
  typePacks: MdbaseDefinitionUpdate[];
  canApply: boolean;
  reason: string;
}

interface ApplicationSessionContext {
  collectionId: string;
  info: MdbaseConnectionInfo;
  capabilities: MdbaseEffectiveCapabilities;
  connections: MdbaseConnectionInfo[];
}

export type MdbaseApplicationSessionSnapshot =
  | { status: "opening"; connections: MdbaseConnectionInfo[] }
  | { status: "unselected"; connections: MdbaseConnectionInfo[] }
  | ({ status: "authorization_required" } & ApplicationSessionContext)
  | ({ status: "checking_setup" } & ApplicationSessionContext)
  | ({ status: "setup_review_required"; update: MdbaseCollectionSetupUpdate } & ApplicationSessionContext)
  | ({ status: "ready"; verification: "cached" | "verified" } & ApplicationSessionContext)
  | {
      status: "unavailable";
      collectionId: string;
      reason: MdbaseUnavailableReason;
      connections: MdbaseConnectionInfo[];
    }
  | ({
      status: "blocked";
      problem: { code: string; message: string; recovery?: string };
    } & ApplicationSessionContext);

/**
 * The application-level lifecycle boundary. It derives authorization from the
 * bundled manifest, exposes semantic capabilities, and never mutates collection
 * setup without an explicit `applyCollectionSetup` call.
 */
export class MdbaseApplicationSession<Frontmatter extends JsonObject = JsonObject> {
  private readonly listeners = new Set<() => void>();
  private readonly verificationStore: MdbaseApplicationVerificationStore;
  private snapshot: MdbaseApplicationSessionSnapshot = { status: "opening", connections: [] };
  private manifest: MdbaseAppManifest | null = null;
  private application: Application | null = null;
  private base: MdbaseSession<Frontmatter> | null = null;
  private stopBase?: () => void;
  private setupAssessment: CollectionSetupAssessment | null = null;
  private verificationGeneration = 0;
  private lifecycleGeneration = 0;
  private startOperation: {
    promise: Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>>;
    controller: AbortController;
    waiters: number;
    generation: number;
  } | null = null;

  constructor(
    private readonly connect: MdbaseApplicationSessionConnect<Frontmatter>,
    private readonly options: MdbaseApplicationSessionOptions,
    private readonly timeouts: ResolvedConnectTimeouts = resolveConnectTimeouts()
  ) {
    this.verificationStore = options.verificationStore ?? defaultVerificationStore();
  }

  start(options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>> {
    if (this.base && !this.startOperation) return Promise.resolve(connectSuccess(this.snapshot));
    const operation = this.startOperation ?? this.beginStart();
    operation.waiters += 1;
    return withRequestBudget(options, this.timeouts.watchStartMs, () => operation.promise)
      .finally(() => {
        operation.waiters -= 1;
        if (operation.waiters === 0 && this.startOperation === operation) {
          operation.controller.abort();
          this.startOperation = null;
          this.lifecycleGeneration += 1;
        }
      });
  }

  private beginStart() {
    this.snapshot = { status: "opening", connections: [] };
    const controller = new AbortController();
    const generation = ++this.lifecycleGeneration;
    const operation = {
      promise: this.startWithinBudget(
        { signal: controller.signal, timeoutMs: null },
        generation
      ),
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

  private async startWithinBudget(
    options: ConnectRequestOptions,
    generation: number
  ): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>> {
    const registration = await this.connect.register(options);
    if (!registration.ok) return registration;
    const manifest = await this.connect.manifest(options);
    if (!manifest.ok) return manifest;
    const capabilities = manifest.value.requirements?.capabilities;
    if (!capabilities) {
      return connectFailure(connectProblem(
        "invalid_application_manifest",
        "Application sessions require a versioned semantic capability contract.",
        {
          details: {
            issues: [{
              path: "/requirements/capabilities",
              keyword: "required",
              message: "is required for application sessions",
              params: {}
            }]
          }
        }
      ));
    }
    if (generation !== this.lifecycleGeneration || options.signal?.aborted) {
      throw requestAbortReason(options.signal ?? new AbortController().signal);
    }
    this.application = registration.value;
    this.manifest = manifest.value;
    const base = new MdbaseSession(this.connect, {
      selection: this.options.selection,
      autoSelect: this.options.autoSelect,
      operations: operationsForSession(capabilities)
    });
    this.base = base;
    try {
      const started = await base.start(options);
      if (!started.ok) {
        this.cleanupBase(base);
        return started;
      }
      if (generation !== this.lifecycleGeneration || options.signal?.aborted) {
        throw requestAbortReason(options.signal ?? new AbortController().signal);
      }
      this.stopBase = base.subscribe(() => {
        if (this.base === base) void this.refresh();
      });
      await this.refresh(true, options);
      if (generation !== this.lifecycleGeneration || options.signal?.aborted) {
        throw requestAbortReason(options.signal ?? new AbortController().signal);
      }
      return connectSuccess(this.snapshot);
    } catch (error) {
      this.cleanupBase(base);
      throw error;
    }
  }

  destroy(): void {
    this.lifecycleGeneration += 1;
    this.verificationGeneration += 1;
    this.startOperation?.controller.abort();
    this.startOperation = null;
    if (this.base) this.cleanupBase(this.base);
    this.application = null;
    this.manifest = null;
    this.setupAssessment = null;
    this.snapshot = { status: "opening", connections: [] };
    this.listeners.clear();
  }

  private cleanupBase(base: MdbaseSession<Frontmatter>): void {
    if (this.base !== base) return;
    this.stopBase?.();
    this.stopBase = undefined;
    base.destroy();
    this.base = null;
  }

  getSnapshot(): MdbaseApplicationSessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connection(): MdbaseConnection<Frontmatter> | null {
    const current = this.base?.getSnapshot();
    return current?.status === "ready" ? current.connection : null;
  }

  select(
    collectionId: string,
    options: { history?: MdbaseSelectionHistory } = {}
  ) {
    return this.requireBase().select(collectionId, options);
  }

  clearSelection(options: { history?: MdbaseSelectionHistory } = {}): void {
    this.requireBase().clearSelection(options);
  }

  forget(collectionId: string): void {
    this.requireBase().forget(collectionId);
  }

  authorize(
    target: "choose" | "selected" | { collectionId: string },
    options: Omit<MdbaseAuthorizeOptions, "operations" | "returnTo" | "target"> = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, SessionProblemCode>> {
    return this.requireBase().authorize(target, options);
  }

  handleAuthorizationCallback(
    callbackUrl: string | URL,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, AuthorizationProblemCode>> {
    return this.requireBase().handleAuthorizationCallback(String(callbackUrl), options);
  }

  completeAuthorization(
    callbackUrl?: string | URL,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, AuthorizationProblemCode>> {
    return this.requireBase().handleAuthorizationCallback(
      callbackUrl === undefined ? defaultCallbackUrl() : String(callbackUrl),
      options
    );
  }

  ensureCapabilities(
    capabilities: ApplicationCapabilityId[],
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<
    MdbaseAuthorizationOutcome<Frontmatter>
    | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> },
    SessionProblemCode
  >> {
    const manifestRequirements = this.requireManifest().requirements?.capabilities;
    const declared = new Set([
      ...(manifestRequirements?.required ?? []),
      ...(manifestRequirements?.optional ?? [])
    ]);
    if (capabilities.some((capability) => !declared.has(capability))) {
      return Promise.resolve(connectFailure(connectProblem(
        "invalid_application_manifest",
        "Applications may only request capabilities declared in their manifest.",
        {
          details: {
            issues: [{
              path: "/requirements/capabilities",
              keyword: "undeclaredCapability",
              message: "must declare every capability requested by the application",
              params: {
                requested: capabilities,
                declared: [...declared]
              }
            }]
          }
        }
      )));
    }
    return this.requireBase().ensureOperations(operationsForIds(capabilities), options);
  }

  async applyCollectionSetup(options?: ConnectRequestOptions): Promise<ConnectOutcome<
    MdbaseApplicationSessionSnapshot,
    CollectionTypeProblemCode | "collection_not_ready"
  >> {
    if (this.snapshot.status !== "setup_review_required" || !this.setupAssessment) {
      return connectFailure(connectProblem(
        "collection_not_ready",
        "There is no reviewed collection setup to apply."
      ));
    }
    if (!this.setupAssessment.applicable) {
      return connectFailure(connectProblem(
        "collection_not_ready",
        "Resolve the collection setup conflicts before applying this update."
      ));
    }
    const connection = this.connection();
    if (!connection) {
      return connectFailure(connectProblem("collection_not_ready", "The collection is not ready."));
    }
    const assessment = this.setupAssessment;
    const input = {
      ...this.collectionSetupInput(),
      expectedAssessmentDigest: assessment.assessmentDigest,
      expectedCollectionRevision: assessment.collectionRevision,
      expectedProvisionDigest: assessment.provisionDigest,
      allowTypePackDowngrades: assessment.typePacks
        .filter((pack) => pack.status === "downgrade")
        .map((pack) => pack.desired.id)
    };
    const budget = createRequestBudget(options, this.timeouts.requestMs);
    const requestOptions = { signal: budget.signal, timeoutMs: null };
    try {
      const applied = await connection.applyCollectionSetup(input, requestOptions);
      if (!applied.ok) return applied;
      this.setupAssessment = null;
      await this.verifySetup(
        this.context(connection),
        ++this.verificationGeneration,
        requestOptions
      );
      return connectSuccess(this.snapshot);
    } finally {
      budget.dispose();
    }
  }

  private async refresh(awaitVerification = false, options?: ConnectRequestOptions): Promise<void> {
    if (!this.base || !this.manifest) return;
    const current = this.base.getSnapshot();
    this.verificationGeneration += 1;
    const generation = this.verificationGeneration;
    this.setupAssessment = null;
    if (current.status === "unselected") {
      this.publish({ status: "unselected", connections: current.connections });
      return;
    }
    if (current.status === "unavailable") {
      this.publish(current);
      return;
    }
    const context = this.context(current.connection);
    if (!context.capabilities.requiredAvailable) {
      this.publish({ status: "authorization_required", ...context });
      return;
    }
    const managesSetup = this.manifest.requirements?.capabilities?.required
      .includes("collection.setup.apply") ?? false;
    if (!managesSetup) {
      this.publish({ status: "ready", verification: "verified", ...context });
      return;
    }
    const key = verificationKey(this.manifest, current.collectionId);
    if (this.verificationStore.read(key) === verificationValue(this.manifest)) {
      this.publish({ status: "ready", verification: "cached", ...context });
    } else {
      this.publish({ status: "checking_setup", ...context });
    }
    const verification = this.verifySetup(context, generation, options);
    if (awaitVerification) await verification;
  }

  private async verifySetup(
    context: ApplicationSessionContext,
    generation: number,
    options?: ConnectRequestOptions
  ): Promise<void> {
    const connection = this.connection();
    const manifest = this.requireManifest();
    if (!connection || connection.collectionId !== context.collectionId) return;
    const outcome = options
      ? await connection.assessCollectionSetup(this.collectionSetupInput(), options)
      : await connection.assessCollectionSetup(this.collectionSetupInput());
    if (generation !== this.verificationGeneration) return;
    if (!outcome.ok) {
      this.publish({ status: "blocked", problem: outcome.problem, ...context });
      return;
    }
    if (generation !== this.verificationGeneration) return;
    if (outcome.value.status !== "current") {
      this.setupAssessment = outcome.value;
      this.verificationStore.remove(verificationKey(manifest, context.collectionId));
      this.publish({
        status: "setup_review_required",
        update: collectionSetupUpdate(outcome.value, manifest.provisions?.type_packs ?? []),
        ...context
      });
      return;
    }
    this.verificationStore.write(
      verificationKey(manifest, context.collectionId),
      verificationValue(manifest)
    );
    this.publish({ status: "ready", verification: "verified", ...context });
  }

  private collectionSetupInput() {
    const manifest = this.requireManifest();
    const application = this.requireApplication();
    return {
      applicationId: declarationIdFromFamilyIdentity(application.family_identity),
      declarationDigest: `sha256:${application.manifest_digest}`,
      requirements: {
        configuration: manifest.requirements?.configuration ?? []
      },
      provisions: {
        configuration: manifest.provisions?.configuration ?? [],
        typePacks: manifest.provisions?.type_packs ?? []
      }
    };
  }

  private context(connection: MdbaseConnection<Frontmatter>): ApplicationSessionContext {
    const info = connection.info()!;
    return {
      collectionId: connection.collectionId,
      info,
      capabilities: effectiveCapabilities(
        this.requireManifest().requirements!.capabilities!,
        this.requireManifest(),
        info
      ),
      connections: this.connect.connections()
    };
  }

  private publish(snapshot: MdbaseApplicationSessionSnapshot): void {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private requireBase(): MdbaseSession<Frontmatter> {
    if (!this.base) throw new Error("Start the application session before using it.");
    return this.base;
  }

  private requireManifest(): MdbaseAppManifest {
    if (!this.manifest) throw new Error("Start the application session before using it.");
    return this.manifest;
  }

  private requireApplication(): Application {
    if (!this.application) throw new Error("Start the application session before using it.");
    return this.application;
  }
}

function operationsForSession(requirements: ApplicationCapabilityRequirements) {
  return operationsForApplicationCapabilities(requirements);
}

function operationsForIds(capabilities: ApplicationCapabilityId[]) {
  const definitions = capabilities.flatMap((id) => capabilityOperations(id));
  return [...new Set(definitions)];
}

function definitionUpdate(
  provision: TypePackProvision,
  assessment: TypePackAssessment
): MdbaseDefinitionUpdate {
  const statusReason = assessment.status === "conflict"
    ? "Existing user-owned resources conflict with this application definition pack."
    : assessment.status === "install"
      ? "This collection needs the application definitions installed."
      : `This collection has a ${assessment.status} definition change to review.`;
  return {
    id: assessment.desired.id,
    name: provision.manifest.name ?? assessment.desired.id,
    status: assessment.status,
    applicable: assessment.applicable,
    assessmentDigest: assessment.assessmentDigest,
    ...(assessment.current ? { currentVersion: assessment.current.version } : {}),
    desiredVersion: assessment.desired.version,
    resources: assessment.resources,
    contractSetups: assessment.contractSetups,
    canApply: assessment.applicable,
    reason: statusReason
  };
}

function collectionSetupUpdate(
  assessment: CollectionSetupAssessment,
  provisions: TypePackProvision[]
): MdbaseCollectionSetupUpdate {
  const typePacks = assessment.typePacks.map((pack) => {
    const provision = provisions.find((candidate) => candidate.manifest.id === pack.desired.id);
    if (!provision) {
      throw new Error(`Collection setup returned undeclared type pack '${pack.desired.id}'.`);
    }
    return definitionUpdate(provision, pack);
  });
  const configurationChanges = assessment.configuration.filter(
    (entry) => entry.action !== "current"
  ).length;
  const reason = assessment.status === "conflict"
    ? "Existing collection policy conflicts with this application's required setup."
    : `This application requires ${configurationChanges} configuration change${configurationChanges === 1 ? "" : "s"} and ${typePacks.length} definition update${typePacks.length === 1 ? "" : "s"}.`;
  return {
    status: assessment.status,
    applicable: assessment.applicable,
    assessmentDigest: assessment.assessmentDigest,
    collectionRevision: assessment.collectionRevision,
    provisionDigest: assessment.provisionDigest,
    configuration: assessment.configuration,
    typePacks,
    canApply: assessment.applicable,
    reason
  };
}

function verificationKey(manifest: MdbaseAppManifest, collectionId: string): string {
  return `mdbase-application-session:v1:${manifest.id}:${collectionId}`;
}

function verificationValue(manifest: MdbaseAppManifest): string {
  return JSON.stringify({
    capabilities: manifest.requirements?.capabilities,
    requirements: manifest.requirements?.configuration ?? [],
    provisions: manifest.provisions ?? {}
  });
}

function declarationIdFromFamilyIdentity(familyIdentity: string): string {
  const prefix = "bundle:";
  if (!familyIdentity.startsWith(prefix) || familyIdentity.length === prefix.length) {
    throw new Error("The registered application has no valid declaration identity.");
  }
  return familyIdentity.slice(prefix.length);
}

function defaultVerificationStore(): MdbaseApplicationVerificationStore {
  if (typeof localStorage !== "undefined") {
    return {
      read: (key) => localStorage.getItem(key),
      write: (key, value) => localStorage.setItem(key, value),
      remove: (key) => localStorage.removeItem(key)
    };
  }
  return new MdbaseMemoryVerificationStore();
}
