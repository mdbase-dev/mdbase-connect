/**
 * `createTestApp`: a lean fake app for UI tests. Real `MdbaseClient`s over
 * in-memory replicas, snapshots for the common screens (signed out, choosing,
 * opening, needs setup, ready, a second tab, a problem), and one-shot faults
 * that fail exactly as production does (same error codes and snapshots).
 * Not runtime, registration or readiness evidence.
 */
import { connect, type MdbaseClient } from "../client.js";
import { mdbaseError, type ErrorCode } from "../errors.js";
import { MdbasePeopleClient } from "../people.js";
import type { CborValue } from "../cbor.js";
import type { ProblemCode } from "../describe-error.js";
import type { MdbaseApplicationDeclaration } from "../application/declaration.js";
import type { MdbaseApplication, MdbaseApplicationConnection, MdbaseApplicationEntry, MdbaseApplicationSnapshot } from "../application/entry.js";
import type { ApplicationApprovalOutcome, ApplicationCollectionSelectionSnapshot } from "../application/collection-selection.js";
import type { AppInstallationCollection, AppInstallationSignInView } from "../app-host/installation-sign-in.js";
import { MemoryReplica } from "./memory-replica.js";
import type { MemoryContract } from "./memory-contracts.js";
import { createApplicationFixture, signedOut, type ApplicationFixtureAction, type ApplicationFixtureControls } from "./application.js";
import { pendingWrites, signOutPendingWritesError } from "../application/sign-out.js";
import { mdbaseFront, type Mdbase } from "../application/front-door.js";

/** The screen to start on (or switch to with `set`). */
export type TestAppPreset = "signed_out" | "choosing" | "opening" | "needs_setup" | "ready" | "second_tab" | { readonly problem: ProblemCode };
export interface TestAppCollection {
  readonly id?: string;
  readonly name?: string;
  readonly role?: AppInstallationCollection["role"];
  readonly records?: readonly { readonly path: string; readonly types?: string[]; readonly frontmatter?: Record<string, CborValue>; readonly body?: string }[];
  readonly contracts?: MemoryContract[];
}
export interface TestAppOptions {
  readonly declaration?: MdbaseApplicationDeclaration;
  /** Default: one collection named "Notes". */
  readonly collections?: readonly TestAppCollection[];
  /** Default: "ready" in the first collection. */
  readonly phase?: TestAppPreset;
  /** Members returned by `connection.people` (the first is the signed-in person). */
  readonly people?: readonly { readonly name: string; readonly role?: AppInstallationCollection["role"] }[];
}
/** One-shot faults, consumed by the next matching action. */
export type TestAppFault =
  /** The Connect window ends without approving (`declined`) or is closed (`closed`). */
  | { readonly action: "approve" | "authorize"; readonly outcome: "declined" | "closed" }
  /** Opening the collection fails: the snapshot is blocked with this problem. */
  | { readonly action: "select"; readonly problem: ProblemCode }
  /** `setup.apply` rejects: the collection changed since review, or the result is unknown. */
  | { readonly action: "applySetup"; readonly reason: "setup_changed" | "outcome_unknown" }
  /** Any action rejects with an `MdbaseError` of this code and reason. */
  | { readonly action: ApplicationFixtureAction; readonly error: { readonly code: ErrorCode; readonly reason: string } };
export interface TestApp {
  readonly entry: MdbaseApplicationEntry;
  readonly application: MdbaseApplication;
  /** The same front door `createMdbase` returns, over this fixture. */
  readonly mdbase: Mdbase;
  /** The replica behind a collection (default: the first), to seed or change records. */
  replica(collectionId?: string): MemoryReplica;
  /** The records client of a collection (default: the first). */
  client(collectionId?: string): MdbaseClient;
  /** Switch screens, e.g. after a test step. Keeps the selected collection when it can. */
  set(preset: TestAppPreset, collectionId?: string): void;
  fail(fault: TestAppFault): void;
  readonly controls: ApplicationFixtureControls;
  close(): Promise<void>;
}

const ACCOUNT = "0b7c6d2e-1a4f-4c3b-9e8d-5f6a7b8c9d0e", INSTALLATION = "1c8d7e3f-2b5a-4d4c-8f9e-6a7b8c9d0e1f";
const DECLARATION: MdbaseApplicationDeclaration = { id: "test.application", name: "Test app", origin: "https://app.test", environment: "lab", manifest: { id: "dev.test.app" } };
const facet = (status: "ready" | "setup_required" | null) => Object.freeze({ checking: false, assessment: status ? Object.freeze({ status, problem: null }) : null, problem: null });
function readiness(status: "ready" | "setup_required" | null): MdbaseApplicationSnapshot["readiness"] {
  const f = facet(status);
  return Object.freeze({ ...f, facets: Object.freeze({ capabilities: f, contracts: f, configuration: f, files: f, people: f, notifications: f }) });
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const specs = options.collections?.length ? options.collections : [{ name: "Notes" }];
  const opened = await Promise.all(specs.map(async (spec, i) => {
    const replica = new MemoryReplica({ confirmDelayMs: 0, ...(spec.id ? { collection: spec.id } : {}), ...(spec.contracts ? { contracts: spec.contracts } : {}) });
    for (const record of spec.records ?? []) replica.seed({ ...record });
    const client = await connect({ connector: replica.connector(), app: { name: "test-app", version: "test" }, reconnect: false });
    const people = options.people ?? [{ name: "Test Person", role: "owner" as const }];
    const profile = (name: string, n: number) => ({ issuer: "https://connect.test", subject: `person-${n}`, name, ...(n === 0 ? { account_id: ACCOUNT } : {}) });
    const peopleClient = new MdbasePeopleClient(client, { collection: client.collection, isCurrent: () => true,
      request: async (resource: "identity" | "members") => resource === "identity" ? profile(people[0]?.name ?? "Test Person", 0)
        : { members: people.map((p, n) => ({ ...profile(p.name, n), role: p.role ?? "editor" })) } });
    const summary: AppInstallationCollection = Object.freeze({ collectionId: client.collection, displayName: spec.name ?? `Collection ${i + 1}`, role: spec.role ?? "owner" });
    const connection: MdbaseApplicationConnection = Object.freeze({ id: client.collection, displayName: summary.displayName,
      scope: Object.freeze({ account: ACCOUNT, installation: INSTALLATION, collection: client.collection }), generation: crypto.randomUUID(),
      records: client, files: client.files, people: peopleClient, isCurrent: () => true });
    return { replica, client, summary, connection };
  }));
  const collections = Object.freeze(opened.map(o => o.summary));
  const signIn: AppInstallationSignInView = Object.freeze({ requestId: crypto.randomUUID(), installationId: INSTALLATION, deviceId: crypto.randomUUID(), appId: crypto.randomUUID(),
    kind: "app-runtime", verificationUri: "https://connect.test/pair", state: "paired", accountId: ACCOUNT, collectionIds: Object.freeze(collections.map(c => c.collectionId)),
    createCollections: false, requestedCreateCollections: false });
  let lastApproval: ApplicationApprovalOutcome | null = null;

  function selection(state: ApplicationCollectionSelectionSnapshot["state"], id: string | null, usable: boolean): ApplicationCollectionSelectionSnapshot {
    const c = collections.find(x => x.collectionId === id) ?? null;
    return Object.freeze({ state, problem: null, usable: usable ? c : null, lastApproval,
      requested: Object.freeze({ collectionId: id, source: id ? "user" as const : "none" as const, displayName: c?.displayName ?? null, approved: c !== null }) });
  }
  function snapshotFor(preset: TestAppPreset, id: string | null = collections[0]!.collectionId): MdbaseApplicationSnapshot {
    const base = { signIn, collections, problem: null, timing: null, selectedCollectionId: null, readiness: readiness(null), selection: selection("none", null, false) };
    if (preset === "signed_out") return { ...base, status: "signed_out", signIn: null, collections: [] };
    if (preset === "choosing") return { ...base, status: "unselected" };
    if (preset === "second_tab") return { ...base, status: "blocked", problem: "open_in_another_tab" };
    if (typeof preset === "object") return { ...base, status: "blocked", problem: preset.problem, selectedCollectionId: id, selection: selection("blocked", id, false) };
    if (preset === "opening") return { ...base, status: "opening", selectedCollectionId: id, selection: selection("opening", id, false) };
    const ready = preset === "ready";
    return { ...base, status: ready ? "ready" : "setup_required", selectedCollectionId: id, readiness: readiness(ready ? "ready" : "setup_required"), selection: selection("usable", id, true) };
  }

  const { entry, controls } = createApplicationFixture({ declaration: options.declaration ?? DECLARATION,
    connections: opened.map(o => o.connection), initialSnapshot: snapshotFor(options.phase ?? "ready") });
  const application = entry.application();
  const faults: TestAppFault[] = [];
  const take = (action: ApplicationFixtureAction) => {
    const i = faults.findIndex(f => f.action === action);
    return i < 0 ? undefined : faults.splice(i, 1)[0];
  };
  const errorFault = (action: ApplicationFixtureAction) => {
    const fault = take(action);
    if (fault && "error" in fault) throw mdbaseError(fault.error.code, `Test fault: ${fault.error.reason}`, fault.error.reason);
    return fault;
  };
  const current = () => application.getSnapshot();
  for (const action of ["start", "reauthorize", "refreshCollectionList", "clearSelection", "chooseAnother", "forget", "deleteCollection", "assess", "configure", "planSetup", "close"] as const)
    controls.setHandler(action, () => { errorFault(action); });
  for (const action of ["authorize", "approve"] as const) controls.setHandler(action, call => {
    const fault = errorFault(action), s = current();
    const kind = action === "approve" && call.collectionId ? "collection" as const : "add" as const;
    if (fault && "outcome" in fault) {
      lastApproval = Object.freeze({ kind, outcome: fault.outcome, collectionId: call.collectionId ?? null });
      return { ...s, ...(s.status === "signed_out" ? { problem: fault.outcome === "closed" ? "approval_window_closed" : "not_authorized" } : {}), selection: { ...s.selection, lastApproval } };
    }
    lastApproval = Object.freeze({ kind, outcome: s.status === "signed_out" ? "added" : "unchanged", collectionId: call.collectionId ?? null });
    return s.status === "signed_out" || s.status === "unselected" ? snapshotFor("choosing") : undefined;
  });
  controls.setHandler("select", call => {
    const fault = errorFault("select");
    if (fault && "problem" in fault) return snapshotFor({ problem: fault.problem }, call.collectionId ?? null);
    return snapshotFor("ready", call.collectionId ?? null);
  });
  // Like production: unconfirmed writes on the open collection refuse sign-out unless discarded.
  controls.setHandler("signOut", call => {
    errorFault("signOut");
    const id = current().selectedCollectionId;
    const pending = !call.discard && id ? pendingWrites(entry.connection(id)) : 0;
    if (pending) throw signOutPendingWritesError(pending);
    return signedOut(current());
  });
  controls.setHandler("applySetup", () => {
    const fault = errorFault("applySetup");
    if (fault && "reason" in fault) throw fault.reason === "setup_changed"
      ? mdbaseError("conflict", "This collection changed since the setup was reviewed. Review it again.", "setup_changed")
      : mdbaseError("outcome_unknown", "The setup result is not known yet.");
    return snapshotFor("ready", current().selectedCollectionId);
  });

  const find = (id?: string) => {
    const found = id === undefined ? opened[0] : opened.find(o => o.client.collection === id);
    if (!found) throw new Error(`No test collection ${id}`);
    return found;
  };
  let closing: Promise<void> | null = null;
  return Object.freeze({
    entry, application, controls, mdbase: mdbaseFront(entry),
    replica: (id?: string) => find(id).replica,
    client: (id?: string) => find(id).client,
    set(preset: TestAppPreset, id?: string) { controls.publishSnapshot(snapshotFor(preset, id ?? current().selectedCollectionId ?? collections[0]!.collectionId)); },
    fail(fault: TestAppFault) { faults.push(Object.freeze({ ...fault })); },
    close() {
      closing ??= (async () => { controls.close(); for (const o of opened) o.client.close(); })();
      return closing;
    },
  });
}

/** `createTestApp`, returning the `Mdbase` front door (as `createMdbase` does);
 * `fixture` keeps the replicas, presets and faults. */
export interface TestMdbase extends Mdbase {
  readonly fixture: TestApp;
}

export async function createTestMdbase(options: TestAppOptions = {}): Promise<TestMdbase> {
  const fixture = await createTestApp(options);
  return Object.freeze({ ...fixture.mdbase, fixture });
}
