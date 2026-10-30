/**
 * D1: the front door. `createMdbase(declaration)` is the one entry an app
 * needs: subscribe to one snapshot whose `phase` says what to show, call
 * gesture-safe actions, and use `phase.connection` once ready. `MdbaseConnect`
 * is the same entry under its previous name, kept for one cut.
 */
import { isMdbaseError, mdbaseError } from "../errors.js";
import type { MdbaseApplicationDeclaration } from "./declaration.js";
import {
  MdbaseConnect, type MdbaseApplication, type MdbaseApplicationConnection, type MdbaseApplicationReadinessSnapshot,
  type MdbaseApplicationRequestOptions, type MdbaseApplicationSnapshot, type MdbaseCollectionDeleteOptions, type MdbaseConnectOptions, type MdbaseLinks,
  type MdbaseSignOutOptions,
} from "./entry.js";
import type { MdbasePhase } from "./phase.js";
import type { StatusSummary } from "../status.js";
import type { MdbaseSetupPlan, MdbaseSetupPlanOptions } from "./setup.js";
import type { MdbaseAccessRequest, MdbaseAccessRequestOptions, MdbaseAccessResult } from "./file-access.js";

/** The application snapshot with the derived fields always present. */
export interface MdbaseSnapshot extends MdbaseApplicationSnapshot {
  readonly phase: MdbasePhase;
  readonly sync: StatusSummary | null;
  readonly links: MdbaseLinks | null;
}
/** SDK-8: how `setup.apply` ended. `changed`: the collection changed since the
 * plan was reviewed (plan again). `unknown`: the result is not known yet; the
 * snapshot settles it. Refusals and other failures still reject. */
export interface MdbaseSetupResult {
  readonly outcome: "applied" | "changed" | "unknown";
  readonly snapshot: MdbaseSnapshot;
}
export interface Mdbase {
  getSnapshot(): MdbaseSnapshot;
  subscribe(listener: () => void): () => void;
  /** Start the session (restores a signed-in device). Safe to call again. */
  start(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Call from the user gesture: sign in (opens Connect). */
  signIn(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Call from the user gesture: choose a Cloud copy or Private collection,
   * or create a collection in Connect. No current collection is preselected. */
  addCollection(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** @deprecated Use `addCollection`. This is the same unified chooser,
   * with the same options and no preselected collection. */
  addPrivateCollection(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Re-read the approved collection list now (for example when a switcher opens). */
  refreshCollectionList(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Call from the user gesture: re-approve the open (or requested) collection,
   * for example after access was lost or the app needs a wider grant. */
  reauthorize(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Configure the open collection from the declaration, with nothing to review
   * (`setup.plan` + `setup.apply` is the reviewable form). */
  configure(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Call from the user gesture: approve one collection (default: the requested one). */
  approve(collectionId?: string | null, options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  select(collectionId: string, options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Close the open collection and show the list; Back restores it. */
  chooseAnother(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Hide a collection on this device (does not revoke access or delete anything). */
  forget(collectionId: string, options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  deleteCollection(collectionId: string, options: MdbaseCollectionDeleteOptions): Promise<MdbaseSnapshot>;
  requestAccess(request: MdbaseAccessRequest, options: MdbaseAccessRequestOptions): Promise<MdbaseAccessResult>;
  /** Re-check the open collection now. */
  assess(options?: MdbaseApplicationRequestOptions): Promise<MdbaseApplicationReadinessSnapshot>;
  readonly setup: {
    plan(options?: MdbaseSetupPlanOptions): Promise<MdbaseSetupPlan>;
    apply(plan: MdbaseSetupPlan, options?: MdbaseApplicationRequestOptions): Promise<MdbaseSetupResult>;
  };
  /** The open collection's connection (also `phase.connection` when ready). */
  connection(collectionId: string): MdbaseApplicationConnection | null;
  setForeground(active: boolean): void;
  /** Sign out of mdbase on this device (see `MdbaseApplication.signOut`).
   * Rejects with `sign_out_pending_writes` while changes are still saving,
   * unless `{discard: true}`. */
  signOut(options?: MdbaseSignOutOptions): Promise<MdbaseSnapshot>;
  close(): Promise<void>;
  /** The underlying application, for code written against `MdbaseConnect`. */
  readonly application: MdbaseApplication;
}

const strict = (s: MdbaseApplicationSnapshot): MdbaseSnapshot => s as MdbaseSnapshot;

/** Create the app's mdbase entry. Construction does no IO; `start()` begins. */
export function createMdbase(declaration: MdbaseApplicationDeclaration, options: MdbaseConnectOptions = {}): Mdbase {
  return mdbaseFront(new MdbaseConnect(declaration, options));
}

/** @internal The front door over any entry (the real one, or the testing fixture's). */
export function mdbaseFront(entry: Pick<MdbaseConnect, "application" | "connection">): Mdbase {
  const app = entry.application();
  const view = () => strict(app.getSnapshot());
  const addCollection = async (o?: MdbaseApplicationRequestOptions) => strict(await app.approve(null, o));
  return Object.freeze({
    getSnapshot: view,
    subscribe: (listener: () => void) => app.subscribe(listener),
    start: async (o?: MdbaseApplicationRequestOptions) => strict(await app.start(o)),
    signIn: async (o?: MdbaseApplicationRequestOptions) => strict(await app.authorize(o)),
    addCollection,
    addPrivateCollection: addCollection,
    approve: async (id?: string | null, o?: MdbaseApplicationRequestOptions) => strict(await app.approve(id, o)),
    refreshCollectionList: async (o?: MdbaseApplicationRequestOptions) => {
      if (!app.refreshCollectionList) throw mdbaseError("unavailable", "Refreshing the collection list isn't available here.", "application_not_yet_available");
      return strict(await app.refreshCollectionList(o));
    },
    reauthorize: async (o?: MdbaseApplicationRequestOptions) => strict(await app.reauthorize(o)),
    configure: async (o?: MdbaseApplicationRequestOptions) => strict(await app.configure(o)),
    select: async (id: string, o?: MdbaseApplicationRequestOptions) => strict(await app.select(id, o)),
    chooseAnother: async (o?: MdbaseApplicationRequestOptions) => strict(await app.chooseAnother(o)),
    forget: async (id: string, o?: MdbaseApplicationRequestOptions) => strict(await app.forget(id, o)),
    deleteCollection: async (id: string, o: MdbaseCollectionDeleteOptions) => strict(await app.deleteCollection(id, o)),
    requestAccess: (request: MdbaseAccessRequest, o: MdbaseAccessRequestOptions) => app.requestAccess(request, o),
    assess: (o?: MdbaseApplicationRequestOptions) => app.assess(o),
    setup: Object.freeze({
      plan: (o?: MdbaseSetupPlanOptions) => app.setup.plan(o),
      async apply(plan: MdbaseSetupPlan, o?: MdbaseApplicationRequestOptions): Promise<MdbaseSetupResult> {
        try { return Object.freeze({ outcome: "applied" as const, snapshot: strict(await app.setup.apply(plan, o)) }); } catch (error) {
          if (isMdbaseError(error, "conflict") && error.reason === "setup_changed") return Object.freeze({ outcome: "changed" as const, snapshot: view() });
          if (isMdbaseError(error, "outcome_unknown")) return Object.freeze({ outcome: "unknown" as const, snapshot: view() });
          throw error;
        }
      },
    }),
    connection: (id: string) => entry.connection(id),
    setForeground: (active: boolean) => app.setForeground(active),
    signOut: async (o?: MdbaseSignOutOptions) => {
      if (!app.signOut) throw mdbaseError("unavailable", "Sign out isn't available here.", "application_not_yet_available");
      return strict(await app.signOut(o));
    },
    close: () => app.close(),
    application: app,
  });
}
