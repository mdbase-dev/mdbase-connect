import {
  capabilityOperations,
  operationsForApplicationCapabilities,
  type ApplicationCapabilityId,
  type ApplicationCapabilityRequirements,
  type JsonObject,
  type MdbaseAppManifest,
  type TypePackAssessment,
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
import {
  MdbaseSession,
  type MdbaseSessionConnect,
  type MdbaseUnavailableReason
} from "./session.js";

export interface MdbaseApplicationSessionConnect<Frontmatter extends JsonObject = JsonObject>
  extends MdbaseSessionConnect<Frontmatter> {
  manifest(): Promise<ConnectOutcome<MdbaseAppManifest, RegistrationProblemCode>>;
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
  contractSetups: TypePackAssessment["contract_setups"];
  canApply: boolean;
  reason: string;
}

interface DefinitionReviewEntry {
  provision: TypePackProvision;
  assessment: TypePackAssessment;
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
  | ({ status: "checking_definitions" } & ApplicationSessionContext)
  | ({ status: "definition_review_required"; updates: MdbaseDefinitionUpdate[] } & ApplicationSessionContext)
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
 * definitions without an explicit `applyDefinitionUpdates` call.
 */
export class MdbaseApplicationSession<Frontmatter extends JsonObject = JsonObject> {
  private readonly listeners = new Set<() => void>();
  private readonly verificationStore: MdbaseApplicationVerificationStore;
  private snapshot: MdbaseApplicationSessionSnapshot = { status: "opening", connections: [] };
  private manifest: MdbaseAppManifest | null = null;
  private base: MdbaseSession<Frontmatter> | null = null;
  private stopBase?: () => void;
  private reviewEntries: DefinitionReviewEntry[] = [];
  private verificationGeneration = 0;

  constructor(
    private readonly connect: MdbaseApplicationSessionConnect<Frontmatter>,
    private readonly options: MdbaseApplicationSessionOptions
  ) {
    this.verificationStore = options.verificationStore ?? defaultVerificationStore();
  }

  async start(): Promise<ConnectOutcome<MdbaseApplicationSessionSnapshot, SessionProblemCode>> {
    const manifest = await this.connect.manifest();
    if (!manifest.ok) return manifest;
    const capabilities = manifest.value.requirements?.capabilities;
    if (!capabilities) {
      return connectFailure(connectProblem(
        "invalid_application_manifest",
        "Application sessions require a versioned semantic capability contract."
      ));
    }
    this.manifest = manifest.value;
    this.base = new MdbaseSession(this.connect, {
      selection: this.options.selection,
      autoSelect: this.options.autoSelect,
      operations: operationsForSession(capabilities)
    });
    this.stopBase = this.base.subscribe(() => this.refresh());
    const started = await this.base.start();
    if (!started.ok) return started;
    await this.refresh(true);
    return connectSuccess(this.snapshot);
  }

  destroy(): void {
    this.verificationGeneration += 1;
    this.stopBase?.();
    this.stopBase = undefined;
    this.base?.destroy();
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
    callbackUrl: string
  ): Promise<ConnectOutcome<MdbaseConnection<Frontmatter>, AuthorizationProblemCode>> {
    return this.requireBase().handleAuthorizationCallback(callbackUrl);
  }

  ensureCapabilities(
    capabilities: ApplicationCapabilityId[]
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
        "Applications may only request capabilities declared in their manifest."
      )));
    }
    return this.requireBase().ensureOperations(operationsForIds(capabilities));
  }

  async applyDefinitionUpdates(): Promise<ConnectOutcome<
    MdbaseApplicationSessionSnapshot,
    CollectionTypeProblemCode | "collection_not_ready"
  >> {
    if (this.snapshot.status !== "definition_review_required" || this.reviewEntries.length === 0) {
      return connectFailure(connectProblem(
        "collection_not_ready",
        "There are no reviewed definition updates to apply."
      ));
    }
    if (this.reviewEntries.some(({ assessment }) => !assessment.applicable)) {
      return connectFailure(connectProblem(
        "collection_not_ready",
        "Resolve the definition conflicts before applying this update."
      ));
    }
    const connection = this.connection();
    if (!connection) {
      return connectFailure(connectProblem("collection_not_ready", "The collection is not ready."));
    }
    for (const { provision, assessment } of this.reviewEntries) {
      const applied = await connection.applyTypePack({
        provision,
        installed_by: this.requireManifest().id,
        expected_assessment_digest: assessment.assessment_digest,
        ...(assessment.status === "downgrade" ? { allow_downgrade: true } : {})
      });
      if (!applied.ok) return applied;
    }
    this.reviewEntries = [];
    await this.verifyDefinitions(this.context(connection), ++this.verificationGeneration);
    return connectSuccess(this.snapshot);
  }

  private async refresh(awaitVerification = false): Promise<void> {
    if (!this.base || !this.manifest) return;
    const current = this.base.getSnapshot();
    this.verificationGeneration += 1;
    const generation = this.verificationGeneration;
    this.reviewEntries = [];
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
    const managesDefinitions = this.manifest.requirements?.capabilities?.required
      .includes("definitions.type-pack.apply") ?? false;
    const provisions = managesDefinitions
      ? this.manifest.provisions?.type_packs ?? []
      : [];
    if (provisions.length === 0) {
      this.publish({ status: "ready", verification: "verified", ...context });
      return;
    }
    const key = verificationKey(this.manifest, current.collectionId);
    if (this.verificationStore.read(key) === verificationValue(this.manifest)) {
      this.publish({ status: "ready", verification: "cached", ...context });
    } else {
      this.publish({ status: "checking_definitions", ...context });
    }
    const verification = this.verifyDefinitions(context, generation);
    if (awaitVerification) await verification;
  }

  private async verifyDefinitions(
    context: ApplicationSessionContext,
    generation: number
  ): Promise<void> {
    const connection = this.connection();
    const manifest = this.requireManifest();
    if (!connection || connection.collectionId !== context.collectionId) return;
    const entries: DefinitionReviewEntry[] = [];
    const managesDefinitions = manifest.requirements?.capabilities?.required
      .includes("definitions.type-pack.apply") ?? false;
    for (const provision of managesDefinitions ? manifest.provisions?.type_packs ?? [] : []) {
      const outcome = await connection.assessTypePack({
        provision,
        installed_by: manifest.id
      });
      if (generation !== this.verificationGeneration) return;
      if (!outcome.ok) {
        this.publish({ status: "blocked", problem: outcome.problem, ...context });
        return;
      }
      if (outcome.value.status !== "current") {
        entries.push({ provision, assessment: outcome.value });
      }
    }
    if (generation !== this.verificationGeneration) return;
    if (entries.length > 0) {
      this.reviewEntries = entries;
      this.verificationStore.remove(verificationKey(manifest, context.collectionId));
      this.publish({
        status: "definition_review_required",
        updates: entries.map(definitionUpdate),
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
}

function operationsForSession(requirements: ApplicationCapabilityRequirements) {
  return operationsForApplicationCapabilities(requirements);
}

function operationsForIds(capabilities: ApplicationCapabilityId[]) {
  const definitions = capabilities.flatMap((id) => capabilityOperations(id));
  return [...new Set(definitions)];
}

function definitionUpdate(entry: DefinitionReviewEntry): MdbaseDefinitionUpdate {
  const { assessment } = entry;
  const statusReason = assessment.status === "conflict"
    ? "Existing user-owned resources conflict with this application definition pack."
    : assessment.status === "install"
      ? "This collection needs the application definitions installed."
      : `This collection has a ${assessment.status} definition change to review.`;
  return {
    id: assessment.desired.id,
    name: entry.provision.manifest.name ?? assessment.desired.id,
    status: assessment.status,
    applicable: assessment.applicable,
    assessmentDigest: assessment.assessment_digest,
    ...(assessment.current ? { currentVersion: assessment.current.version } : {}),
    desiredVersion: assessment.desired.version,
    resources: assessment.resources,
    contractSetups: assessment.contract_setups,
    canApply: assessment.applicable,
    reason: statusReason
  };
}

function verificationKey(manifest: MdbaseAppManifest, collectionId: string): string {
  return `mdbase-application-session:v1:${manifest.id}:${collectionId}`;
}

function verificationValue(manifest: MdbaseAppManifest): string {
  return JSON.stringify({
    capabilities: manifest.requirements?.capabilities,
    provisions: manifest.provisions?.type_packs ?? []
  });
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
