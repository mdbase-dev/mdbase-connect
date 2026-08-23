import {
  capabilityOperations,
  operationsForApplicationCapabilities,
  type ApplicationCapabilityId,
  type ApplicationCapabilityRequirements,
  type ConnectProblem,
  type ConnectProblemCode,
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
import { MdbaseConnectError, connectProblem } from "./errors.js";
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
  connectionApplicationId(collectionId: string): string | null;
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

type LifecycleProblemCode =
  | "session_destroyed"
  | "session_not_started"
  | "session_starting";

export type MdbaseApplicationSessionSnapshot =
  | { status: "not_started"; connections: MdbaseConnectionInfo[] }
  | { status: "starting"; connections: MdbaseConnectionInfo[] }
  | {
      status: "start_failed";
      problem: ConnectProblem<SessionProblemCode>;
      connections: MdbaseConnectionInfo[];
    }
  | { status: "destroyed"; connections: MdbaseConnectionInfo[] }
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
  private snapshot: MdbaseApplicationSessionSnapshot = { status: "not_started", connections: [] };
  private manifest: MdbaseAppManifest | null = null;
  private application: Application | null = null;
  private base: MdbaseSession<Frontmatter> | null = null;
  private stopBase?: () => void;
  private setupAssessment: CollectionSetupAssessment | null = null;
  private setupTypePackAdoptions: Record<string, Record<string, string>> | null = null;
  private verificationGeneration = 0;
  private lifecycleGeneration = 0;
  private readonly operationControllers = new Set<AbortController>();
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
    if (this.snapshot.status === "destroyed") {
      return Promise.resolve(connectFailure(connectProblem(
        "session_destroyed",
        "This application session has been destroyed."
      )));
    }
    if (this.base && !this.startOperation) return Promise.resolve(connectSuccess(this.snapshot));
    const operation = this.startOperation ?? this.beginStart();
    return this.waitForStart(operation, options, this.timeouts.watchStartMs);
  }

  private async waitForStart(
    operation: NonNullable<MdbaseApplicationSession<Frontmatter>["startOperation"]>,
    options: ConnectRequestOptions | undefined,
    timeoutMs: number | null
  ): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>> {
    operation.waiters += 1;
    try {
      return await withRequestBudget(options, timeoutMs, () => operation.promise);
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem as ConnectProblem<SessionProblemCode>);
      }
      throw error;
    } finally {
      operation.waiters -= 1;
      if (operation.waiters === 0 && this.startOperation === operation) {
        this.abandonStart(operation);
      }
    }
  }

  private abandonStart(
    operation: NonNullable<MdbaseApplicationSession<Frontmatter>["startOperation"]>
  ): void {
    operation.controller.abort();
    this.startOperation = null;
    this.lifecycleGeneration += 1;
    this.verificationGeneration += 1;
    if (this.base) this.cleanupBase(this.base);
    this.application = null;
    this.manifest = null;
    this.setupAssessment = null;
    this.setupTypePackAdoptions = null;
    this.publish({ status: "not_started", connections: this.connect.connections() });
  }

  private beginStart() {
    this.publish({ status: "starting", connections: this.connect.connections() });
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
    try {
      return await this.performStartWithinBudget(options, generation);
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        return this.startFailure(
          error.problem as ConnectProblem<SessionProblemCode>,
          generation
        );
      }
      if (generation === this.lifecycleGeneration) {
        this.verificationGeneration += 1;
        if (this.base) this.cleanupBase(this.base);
        this.application = null;
        this.manifest = null;
        this.setupAssessment = null;
        this.setupTypePackAdoptions = null;
        this.publish({ status: "not_started", connections: this.connect.connections() });
      }
      throw error;
    }
  }

  private async performStartWithinBudget(
    options: ConnectRequestOptions,
    generation: number
  ): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>> {
    const registration = await this.connect.register(options);
    if (!registration.ok) return this.startFailure(registration.problem, generation);
    const manifest = await this.connect.manifest(options);
    if (!manifest.ok) return this.startFailure(manifest.problem, generation);
    const capabilities = manifest.value.requirements?.capabilities;
    if (!capabilities) {
      return this.startFailure(connectProblem(
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
      ), generation);
    }
    if (generation !== this.lifecycleGeneration || options.signal?.aborted) {
      return connectFailure(connectProblem(
        "operation_cancelled",
        "Application session startup was cancelled.",
        { operationOutcome: "not_sent" }
      ));
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
        return this.startFailure(started.problem, generation);
      }
      if (generation !== this.lifecycleGeneration || options.signal?.aborted) {
        this.cleanupBase(base);
        return connectFailure(connectProblem(
          "operation_cancelled",
          "Application session startup was cancelled.",
          { operationOutcome: "not_sent" }
        ));
      }
      this.stopBase = base.subscribe(() => {
        if (this.base === base) void this.refresh();
      });
      await this.refresh(true, options);
      if (generation !== this.lifecycleGeneration || options.signal?.aborted) {
        this.cleanupBase(base);
        return connectFailure(connectProblem(
          "operation_cancelled",
          "Application session startup was cancelled.",
          { operationOutcome: "not_sent" }
        ));
      }
      return connectSuccess(this.snapshot);
    } catch (error) {
      this.cleanupBase(base);
      throw error;
    }
  }

  private startFailure(
    problem: ConnectProblem<SessionProblemCode>,
    generation: number
  ): ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode> {
    if (generation === this.lifecycleGeneration) {
      this.publish({
        status: "start_failed",
        problem,
        connections: this.connect.connections()
      });
    }
    return connectFailure(problem);
  }

  destroy(): void {
    if (this.snapshot.status === "destroyed") return;
    this.lifecycleGeneration += 1;
    this.verificationGeneration += 1;
    this.startOperation?.controller.abort();
    this.startOperation = null;
    for (const controller of this.operationControllers) controller.abort();
    this.operationControllers.clear();
    if (this.base) this.cleanupBase(this.base);
    this.application = null;
    this.manifest = null;
    this.setupAssessment = null;
    this.setupTypePackAdoptions = null;
    this.publish({ status: "destroyed", connections: [] });
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
  ): ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode> {
    const base = this.lifecycleBase();
    return base.ok ? base.value.select(collectionId, options) : base;
  }

  clearSelection(options: { history?: MdbaseSelectionHistory } = {}): ConnectOutcome<void, SessionProblemCode> {
    const base = this.lifecycleBase();
    if (!base.ok) return base;
    base.value.clearSelection(options);
    return connectSuccess(undefined);
  }

  forget(collectionId: string): ConnectOutcome<void, SessionProblemCode> {
    const base = this.lifecycleBase();
    if (!base.ok) return base;
    base.value.forget(collectionId);
    return connectSuccess(undefined);
  }

  authorize(
    target: "choose" | "selected" | { collectionId: string },
    options: Omit<MdbaseAuthorizeOptions, "operations" | "returnTo" | "target"> = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, SessionProblemCode>> {
    return this.withLifecycleBase(options, async (base, requestOptions, generation) => {
      const outcome = await base.authorize(target, { ...options, ...requestOptions });
      if (outcome.ok && outcome.value.kind === "connected" && this.lifecycleCurrent(generation)) {
        await this.refresh(true, requestOptions);
      }
      return outcome;
    });
  }

  handleAuthorizationCallback(
    callbackUrl: string | URL,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode>> {
    const exactUrl = String(callbackUrl);
    const joinsStartupCallback = this.startOperation !== null
      && this.options.selection.authorizationCallback() === exactUrl;
    return this.withLifecycleBase(options, async (base, requestOptions, generation) => {
      if (joinsStartupCallback) {
        const current = base.getSnapshot();
        if (current.status === "ready") return connectSuccess(current.connection);
        return connectFailure(connectProblem("collection_not_ready", "Authorization did not produce a ready collection."));
      }
      const outcome = await base.handleAuthorizationCallback(exactUrl, requestOptions);
      if (outcome.ok && this.lifecycleCurrent(generation)) await this.refresh(true, requestOptions);
      return outcome;
    });
  }

  completeAuthorization(
    callbackUrl?: string | URL,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, SessionProblemCode>> {
    const exactUrl = callbackUrl === undefined ? defaultCallbackUrl() : String(callbackUrl);
    const joinsStartupCallback = this.startOperation !== null
      && this.options.selection.authorizationCallback() === exactUrl;
    return this.withLifecycleBase(options, async (base, requestOptions, generation) => {
      if (joinsStartupCallback) {
        const current = base.getSnapshot();
        if (current.status === "ready") return connectSuccess(current.connection);
        return connectFailure(connectProblem("collection_not_ready", "Authorization did not produce a ready collection."));
      }
      const outcome = await base.handleAuthorizationCallback(exactUrl, requestOptions);
      if (outcome.ok && this.lifecycleCurrent(generation)) await this.refresh(true, requestOptions);
      return outcome;
    });
  }

  ensureCapabilities(
    capabilities: ApplicationCapabilityId[],
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<
    MdbaseAuthorizationOutcome<Frontmatter>
    | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> },
    SessionProblemCode
  >> {
    return this.withLifecycleBase(options, (base, requestOptions, generation) => {
      const manifestRequirements = this.manifest!.requirements?.capabilities;
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
      return base.ensureOperations(operationsForIds(capabilities), requestOptions).then(async (outcome) => {
        if (outcome.ok && outcome.value.kind === "connected" && this.lifecycleCurrent(generation)) {
          await this.refresh(true, requestOptions);
        }
        return outcome;
      });
    });
  }

  applyCollectionSetup(options?: ConnectRequestOptions): Promise<ConnectOutcome<
    MdbaseApplicationSessionSnapshot,
    CollectionTypeProblemCode | SessionProblemCode
  >> {
    return this.withLifecycleBase(options, (_base, requestOptions, generation) =>
      this.applyCollectionSetupStarted(requestOptions, generation)
    );
  }

  private async applyCollectionSetupStarted(options: ConnectRequestOptions, generation: number): Promise<ConnectOutcome<
    MdbaseApplicationSessionSnapshot,
    CollectionTypeProblemCode | SessionProblemCode | "collection_not_ready"
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
      ...this.collectionSetupInput(this.setupTypePackAdoptions ?? undefined),
      expectedAssessmentDigest: assessment.assessmentDigest,
      expectedCollectionRevision: assessment.collectionRevision,
      expectedProvisionDigest: assessment.provisionDigest,
      allowTypePackDowngrades: assessment.typePacks
        .filter((pack) => pack.status === "downgrade")
        .map((pack) => pack.desired.id)
    };
    const applied = await connection.applyCollectionSetup(input, options);
    if (!this.lifecycleCurrent(generation)) {
      if (!applied.ok && applied.problem.code === "operation_outcome_unknown") {
        return connectFailure(applied.problem);
      }
      return connectFailure(connectProblem("session_destroyed", lifecycleProblemMessage("session_destroyed")));
    }
    if (!applied.ok) {
      if (applied.problem.code === "application_declaration_mismatch") {
        this.setupAssessment = null;
        this.setupTypePackAdoptions = null;
        this.publish({ status: "authorization_required", ...this.context(connection) });
      }
      return applied;
    }
    this.setupAssessment = null;
    this.setupTypePackAdoptions = null;
    await this.verifySetup(
      this.context(connection),
      ++this.verificationGeneration,
      options
    );
    return connectSuccess(this.snapshot);
  }

  private async refresh(awaitVerification = false, options?: ConnectRequestOptions): Promise<void> {
    if (!this.base || !this.manifest) return;
    const current = this.base.getSnapshot();
    this.verificationGeneration += 1;
    const generation = this.verificationGeneration;
    this.setupAssessment = null;
    this.setupTypePackAdoptions = null;
    if (current.status === "unselected") {
      this.publish({ status: "unselected", connections: current.connections });
      return;
    }
    if (current.status === "unavailable") {
      this.publish(current);
      return;
    }
    if (current.status !== "ready") return;
    const context = this.context(current.connection);
    if (
      this.connect.connectionApplicationId(current.collectionId) !== this.application?.id
    ) {
      this.publish({ status: "authorization_required", ...context });
      return;
    }
    if (
      !context.capabilities.requiredAvailable
      || !accessRequirementSatisfied(this.manifest, context.info)
    ) {
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
    const initialInput = this.collectionSetupInput();
    let outcome = options
      ? await connection.assessCollectionSetup(initialInput, options)
      : await connection.assessCollectionSetup(initialInput);
    if (generation !== this.verificationGeneration) return;
    if (!outcome.ok) {
      this.publish(outcome.problem.code === "application_declaration_mismatch"
        ? { status: "authorization_required", ...context }
        : { status: "blocked", problem: outcome.problem, ...context });
      return;
    }
    if (!outcome.value.applicable) {
      const adoptions = reviewableTypePackAdoptions(outcome.value);
      if (Object.keys(adoptions).length > 0) {
        outcome = options
          ? await connection.assessCollectionSetup(
              this.collectionSetupInput(adoptions),
              options
            )
          : await connection.assessCollectionSetup(this.collectionSetupInput(adoptions));
        if (generation !== this.verificationGeneration) return;
        if (!outcome.ok) {
          this.publish(outcome.problem.code === "application_declaration_mismatch"
            ? { status: "authorization_required", ...context }
            : { status: "blocked", problem: outcome.problem, ...context });
          return;
        }
        this.setupTypePackAdoptions = adoptions;
      }
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

  private collectionSetupInput(typePackAdoptions?: Record<string, Record<string, string>>) {
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
      },
      ...(typePackAdoptions ? { typePackAdoptions } : {})
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
    if (this.snapshot.status === "destroyed" && snapshot.status !== "destroyed") return;
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private lifecycleBase(): ConnectOutcome<MdbaseSession<Frontmatter>, SessionProblemCode> {
    const status = this.snapshot.status;
    if (this.startOperation || status === "starting") {
      return connectFailure(connectProblem(
        "session_starting",
        "The application session is still starting."
      ));
    }
    if (this.snapshot.status === "start_failed") return connectFailure(this.snapshot.problem);
    if (this.base) return connectSuccess(this.base);
    const code = status === "destroyed"
      ? "session_destroyed"
      : "session_not_started";
    return connectFailure(connectProblem(code, lifecycleProblemMessage(code)));
  }

  private async withLifecycleBase<Value, Code extends ConnectProblemCode>(
    options: ConnectRequestOptions | undefined,
    operation: (
      base: MdbaseSession<Frontmatter>,
      options: ConnectRequestOptions,
      generation: number
    ) => Promise<ConnectOutcome<Value, Code>>
  ): Promise<ConnectOutcome<Value, Code | SessionProblemCode>> {
    const lifecycle = this.beginLifecycleOperation(options);
    const budget = createRequestBudget(lifecycle.options, this.timeouts.requestMs);
    const requestOptions = { signal: budget.signal, timeoutMs: null };
    try {
      const starting = this.startOperation;
      if (starting) {
        const started = await this.waitForStart(starting, requestOptions, null);
        if (!started.ok) return started;
      }
      if (!this.lifecycleCurrent(lifecycle.generation)) {
        return connectFailure(connectProblem(
          "session_destroyed",
          lifecycleProblemMessage("session_destroyed")
        ) as ConnectProblem<Code | SessionProblemCode>);
      }
      const base = this.lifecycleBase();
      if (!base.ok) return base;
      const outcome = await operation(base.value, requestOptions, lifecycle.generation);
      if (!this.lifecycleCurrent(lifecycle.generation)) return this.destroyedOutcome(outcome);
      return outcome;
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        if (!this.lifecycleCurrent(lifecycle.generation)) {
          if (error.problem.code === "operation_outcome_unknown") {
            return connectFailure(error.problem as ConnectProblem<Code | SessionProblemCode>);
          }
          return connectFailure(connectProblem(
            "session_destroyed",
            lifecycleProblemMessage("session_destroyed")
          ) as ConnectProblem<Code | SessionProblemCode>);
        }
        return connectFailure(error.problem as ConnectProblem<Code | SessionProblemCode>);
      }
      throw error;
    } finally {
      budget.dispose();
      lifecycle.dispose();
    }
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
    return this.snapshot.status !== "destroyed" && generation === this.lifecycleGeneration;
  }

  private destroyedOutcome<Code extends ConnectProblemCode>(
    outcome: ConnectOutcome<unknown, Code>
  ): ConnectOutcome<never, Code | SessionProblemCode> {
    if (!outcome.ok && outcome.problem.code === "operation_outcome_unknown") return outcome;
    return connectFailure(connectProblem(
      "session_destroyed",
      lifecycleProblemMessage("session_destroyed")
    ) as ConnectProblem<Code | SessionProblemCode>);
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

function reviewableTypePackAdoptions(
  assessment: CollectionSetupAssessment
): Record<string, Record<string, string>> {
  const adoptions: Record<string, Record<string, string>> = {};
  for (const pack of assessment.typePacks) {
    const resources = Object.fromEntries(
      pack.resources
        .filter((resource) =>
          resource.action === "conflict"
          && resource.mode === "managed"
          && resource.currentDigest !== undefined
          && resource.installedDigest === undefined
        )
        .map((resource) => [resource.target, resource.currentDigest!])
    );
    if (Object.keys(resources).length > 0) adoptions[pack.desired.id] = resources;
  }
  return adoptions;
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

function accessRequirementSatisfied(
  manifest: MdbaseAppManifest,
  connection: MdbaseConnectionInfo
): boolean {
  return manifest.requirements?.access !== "full_collection"
    || connection.scope.access === "full_collection";
}

function declarationIdFromFamilyIdentity(familyIdentity: string): string {
  const prefix = "bundle:";
  if (!familyIdentity.startsWith(prefix) || familyIdentity.length === prefix.length) {
    throw new Error("The registered application has no valid declaration identity.");
  }
  return familyIdentity.slice(prefix.length);
}

function lifecycleProblemMessage(code: LifecycleProblemCode): string {
  if (code === "session_destroyed") return "This application session has been destroyed.";
  if (code === "session_starting") return "The application session is still starting.";
  return "Start the application session before using it.";
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
