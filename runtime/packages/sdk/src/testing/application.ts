/** Application UI fixtures, NOT registration/runtime/readiness/physical-close evidence.
 * Supplies the public structural entry and unchanged borrowed native clients.
 * Only test metadata and action outcomes are controlled here; no production IO.
 */
import {applicationDeclaration, type MdbaseApplicationDeclaration} from "../application/declaration.js";
import type {
  MdbaseApplication, MdbaseApplicationConnection, MdbaseApplicationEntry,
  MdbaseApplicationRequestOptions, MdbaseApplicationSnapshot, MdbaseCollectionDeleteOptions,
} from "../application/entry.js";
import type {MdbaseSetupPlan} from "../application/setup.js";

export type ApplicationFixtureAction = "start" | "authorize" | "approve" | "reauthorize" | "select" | "clearSelection" | "chooseAnother" | "forget" | "deleteCollection" | "assess" | "configure" | "planSetup" | "applySetup" | "close";
export interface ApplicationFixtureCall {
  readonly action: ApplicationFixtureAction | "setForeground";
  readonly collectionId?: string;
  /** `deleteCollection`: the typed confirmation name. */
  readonly confirmName?: string;
  /** Original caller signal, never a fixture-created replacement. */
  readonly signal?: AbortSignal;
  readonly active?: boolean;
}
export type ApplicationFixtureHandler = (call: ApplicationFixtureCall) =>
  void | MdbaseApplicationSnapshot | Promise<void | MdbaseApplicationSnapshot>;
export interface ApplicationFixtureOptions {
  readonly declaration: MdbaseApplicationDeclaration;
  readonly connections: readonly MdbaseApplicationConnection[];
  readonly initialSnapshot: MdbaseApplicationSnapshot;
}
export interface ApplicationFixtureControls {
  readonly declaration: MdbaseApplicationDeclaration;
  /** Defensive frozen copies: fixture metadata is never production evidence. */
  publishSnapshot(snapshot: MdbaseApplicationSnapshot): void;
  /** Replace fixture lookup bindings without closing any supplied client. */
  setConnections(connections: readonly MdbaseApplicationConnection[]): void;
  /** Custom outcomes/delays/refusals, including blocked authorization/failed close.
   * assess handlers supply a full snapshot; assess returns its readiness only. */
  setHandler(action: ApplicationFixtureAction, handler: ApplicationFixtureHandler): () => void;
  /** The plan `application.setup.plan` returns (a plain object); none refuses. */
  setSetupPlan(plan: MdbaseSetupPlan | null): void;
  observedActions(): readonly ApplicationFixtureCall[];
  /** Release fixture-owned notifications/currentness, not borrowed clients. */
  close(): void;
}
export interface ApplicationFixture {
  readonly entry: MdbaseApplicationEntry;
  readonly controls: ApplicationFixtureControls;
}

function frozenSnapshot(snapshot: MdbaseApplicationSnapshot): MdbaseApplicationSnapshot {
  const copy = structuredClone(snapshot);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}

/** Frozen public test seam. No constructor override, alternate engine or alias.
 * Fixture lifetime fences are combined with supplied connection.isCurrent().
 * Original scope/generation and clients stay exact; no production scope is minted.
 * Selection/configuration never infer readiness or modify supplied native data.
 */
export function createApplicationFixture(options: ApplicationFixtureOptions): ApplicationFixture {
  const declaration = applicationDeclaration(options.declaration);
  let snapshot = frozenSnapshot(options.initialSnapshot);
  let connections = bindings(options.connections);
  const listeners = new Set<() => void>();
  const handlers = new Map<ApplicationFixtureAction, ApplicationFixtureHandler>();
  const calls: ApplicationFixtureCall[] = [];
  let closed = false;
  let closeJob: Promise<void> | undefined;
  let actionGeneration = 0;
  let setupPlan: MdbaseSetupPlan | null = null;
  let active: {source: MdbaseApplicationConnection; view: MdbaseApplicationConnection} | undefined;

  function bindings(values: readonly MdbaseApplicationConnection[]): Map<string, MdbaseApplicationConnection> {
    const result = new Map<string, MdbaseApplicationConnection>();
    for (const connection of values) {
      if (result.has(connection.id)) throw new Error("Duplicate fixture connection");
      if (connection.records.collection !== connection.id || connection.files !== connection.records.files) {
        throw new Error("Fixture connection must supply its original native collection and files client");
      }
      result.set(connection.id, connection);
    }
    return result;
  }
  function publish(next: MdbaseApplicationSnapshot): void {
    const copy = frozenSnapshot(next);
    if (copy.selectedCollectionId !== snapshot.selectedCollectionId) active = undefined;
    snapshot = copy;
    for (const listener of [...listeners]) if (listeners.has(listener)) listener();
  }
  function closeFixture(): void {
    if (closed) return;
    closed = true;
    ++actionGeneration;
    active = undefined;
    connections.clear();
    listeners.clear();
    handlers.clear();
  }
  async function run(action: ApplicationFixtureAction, request: MdbaseApplicationRequestOptions = {}, collectionId?: string, confirmName?: string): Promise<MdbaseApplicationSnapshot> {
    request.signal?.throwIfAborted();
    if (closed || closeJob) throw new Error("Application fixture is closed or closing");
    const generation = ++actionGeneration;
    const call: ApplicationFixtureCall = Object.freeze({action,
      ...(collectionId !== undefined ? {collectionId} : {}),
      ...(confirmName !== undefined ? {confirmName} : {}),
      ...(request.signal ? {signal: request.signal} : {})});
    calls.push(call);
    const outcome = await handlers.get(action)?.(call);
    request.signal?.throwIfAborted();
    // A retired action cannot restore old fixture selection/metadata.
    if (closed || generation !== actionGeneration) return snapshot;
    if (action === "close") {closeFixture(); return snapshot;}
    if (outcome) publish(outcome);
    else if (action === "select") publish({...snapshot, selectedCollectionId: collectionId ?? null});
    else if (action === "clearSelection" || action === "chooseAnother") publish({...snapshot, selectedCollectionId: null});
    else if (action === "forget" || action === "deleteCollection") publish({...snapshot,
      collections: snapshot.collections.filter(collection => collection.collectionId !== collectionId),
      selectedCollectionId: snapshot.selectedCollectionId === collectionId ? null : snapshot.selectedCollectionId});
    return snapshot;
  }
  const application: MdbaseApplication = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (closed) return () => {};
      const subscription = () => listener();
      listeners.add(subscription);
      return () => {listeners.delete(subscription);};
    },
    start: (request?: MdbaseApplicationRequestOptions) => run("start", request),
    authorize: (request?: MdbaseApplicationRequestOptions) => run("authorize", request),
    select: (id: string, request?: MdbaseApplicationRequestOptions) => run("select", request, id),
    approve: (id?: string | null, request?: MdbaseApplicationRequestOptions) => run("approve", request, id ?? undefined),
    reauthorize: (request?: MdbaseApplicationRequestOptions) => run("reauthorize", request),
    clearSelection: (request?: MdbaseApplicationRequestOptions) => run("clearSelection", request),
    chooseAnother: (request?: MdbaseApplicationRequestOptions) => run("chooseAnother", request),
    forget: (id: string, request?: MdbaseApplicationRequestOptions) => run("forget", request, id),
    deleteCollection: (id: string, {confirmName, ...request}: MdbaseCollectionDeleteOptions) => run("deleteCollection", request, id, confirmName),
    assess: async (request?: MdbaseApplicationRequestOptions) => (await run("assess", request)).readiness,
    configure: (request?: MdbaseApplicationRequestOptions) => run("configure", request),
    setup: Object.freeze({
      async plan(request?: MdbaseApplicationRequestOptions) {
        await run("planSetup", request);
        if (!setupPlan) throw new Error("No fixture setup plan; call controls.setSetupPlan");
        return setupPlan;
      },
      apply: (_plan: MdbaseSetupPlan, request?: MdbaseApplicationRequestOptions) => run("applySetup", request),
    }),
    setForeground(active: boolean) {calls.push(Object.freeze({action: "setForeground", active}));},
    close() {
      if (closed) return Promise.resolve();
      if (closeJob) return closeJob;
      const job = run("close").then(() => {});
      closeJob = job;
      void job.then(() => {closeJob = undefined;}, () => {closeJob = undefined;});
      return job;
    },
  });
  const entry: MdbaseApplicationEntry = Object.freeze({
    application: () => application,
    connection(id: string) {
      if (closed || snapshot.selectedCollectionId !== id) return null;
      const source = connections.get(id);
      if (!source) return null;
      if (active?.source === source) return active.view;
      const view: MdbaseApplicationConnection = Object.freeze({
        id: source.id, displayName: source.displayName,
        scope: source.scope, generation: source.generation,
        records: source.records, files: source.files, people: source.people,
        ...(source.timers ? {timers: source.timers} : {}),
        isCurrent: () => !closed && active?.view === view && snapshot.selectedCollectionId === id && connections.get(id) === source && source.isCurrent()});
      active = {source, view};
      return view;
    },
  });
  const controls: ApplicationFixtureControls = Object.freeze({
    declaration,
    publishSnapshot(next: MdbaseApplicationSnapshot) {
      if (closed || closeJob) throw new Error("Application fixture is closed or closing");
      ++actionGeneration;
      publish(next);
    },
    setConnections(next: readonly MdbaseApplicationConnection[]) {
      if (closed || closeJob) throw new Error("Application fixture is closed or closing");
      connections = bindings(next);
      active = undefined;
      ++actionGeneration;
      publish(snapshot);
    },
    setHandler(action: ApplicationFixtureAction, handler: ApplicationFixtureHandler) {
      handlers.set(action, handler);
      return () => {if (handlers.get(action) === handler) handlers.delete(action);};
    },
    setSetupPlan(plan: MdbaseSetupPlan | null) {setupPlan = plan;},
    observedActions: () => Object.freeze([...calls]),
    close: closeFixture,
  });
  return Object.freeze({entry, controls});
}
