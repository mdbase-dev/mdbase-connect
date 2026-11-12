/**
 * D1: the front door. `createMdbase(declaration)` is the one entry an app
 * needs: subscribe to one snapshot whose `phase` says what to show, call
 * gesture-safe actions, and use `phase.connection` once ready.
 */
import type { MdbaseApplicationDeclaration } from "./declaration.js";
import {
  MdbaseEntry, type MdbaseApplicationConnection, type MdbaseApplicationReadinessSnapshot,
  type MdbaseApplicationRequestOptions, type MdbaseApplicationSnapshot, type MdbaseCollectionDeleteOptions, type MdbaseLinks, type MdbaseOptions,
  type MdbaseSignOutOptions, type MdbaseTransferOptions, type MdbaseTransferPlanOptions, type MdbaseUnlockSecret,
} from "./entry.js";
import type { MdbaseTransferPlan, MdbaseTransferResult } from "./unsynced-transfer.js";
import type { MdbasePhase } from "./phase.js";
import type { MdbaseSync } from "../status.js";
import type { MdbaseSetupPlan, MdbaseSetupPlanOptions } from "./setup.js";
import type { MdbaseAccessRequest, MdbaseAccessRequestOptions, MdbaseAccessResult } from "./file-access.js";

/** The application snapshot with the derived fields always present. */
export interface MdbaseSnapshot extends MdbaseApplicationSnapshot {
  readonly phase: MdbasePhase;
  readonly sync: MdbaseSync | null;
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
  /** Owner only, from an explicit confirmation: delete a collection for
   * everyone, on every device and app. `confirmName` is the name the person
   * typed; it must equal the collection's current name. A refusal rejects
   * with a `collection_delete_*` code for `describeError` and changes nothing
   * locally. On success the collection leaves `collections`. */
  deleteCollection(collectionId: string, options: MdbaseCollectionDeleteOptions): Promise<MdbaseSnapshot>;
  /** Call from the user gesture the first time the app needs an optional file
   * action (for example adding an image). Resolves `granted` at once when it
   * is already allowed; otherwise opens Connect for the open collection with
   * your one-line reason. No reload: the connection and app state stay. An
   * action the manifest does not declare rejects with `access_undeclared`.
   * File writes the person has not allowed reject with `access_required`. */
  requestAccess(request: MdbaseAccessRequest, options: MdbaseAccessRequestOptions): Promise<MdbaseAccessResult>;
  /** Unlock the open Private collection (`phase.kind === "needs_unlock"` with
   * `mode: "password"`) with the encryption password or the recovery key.
   * Resolves once the attempt settled: opened, or still `needs_unlock` with
   * `phase.problem` set. Pass the typed value straight through; keep no copy. */
  unlock(collectionId: string, secret: MdbaseUnlockSecret, options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  /** Re-check the open collection now. */
  assess(options?: MdbaseApplicationRequestOptions): Promise<MdbaseApplicationReadinessSnapshot>;
  readonly setup: {
    /** Plan setup of the open collection. Changes no collection data (it may
     * settle the local journal of an earlier apply); call again after any decision. */
    plan(options?: MdbaseSetupPlanOptions): Promise<MdbaseSetupPlan>;
    /** Apply a plan from `plan` unchanged, as one guarded mutation. */
    apply(plan: MdbaseSetupPlan, options?: MdbaseApplicationRequestOptions): Promise<MdbaseSetupResult>;
  };
  /** The open collection's connection (also `phase.connection` when ready). */
  connection(collectionId: string): MdbaseApplicationConnection | null;
  setForeground(active: boolean): void;
  /** Sign out of mdbase on this device: ends the server session and removes
   * this browser's sign-in data, keys and cached collections for the account.
   * Rejects with `sign_out_pending_writes` (a `conflict`) while changes have not
   * reached mdbase, unless `{discard: true}`. Resolves signed out; Sign in works
   * again without a reload, and a reload stays signed out. A server sign-out
   * that could not complete (offline) still signs this device out; it shows
   * in `signOutResult`. */
  signOut(options?: MdbaseSignOutOptions): Promise<MdbaseSnapshot>;
  close(): Promise<void>;
  /** Work before connecting (the `unsynced` option). */
  readonly unsynced: {
    /** Open the app's unsynced collection in this tab, creating it on first
     * use: for "Continue without connecting". Signed out with nothing
     * requested, `start()` already does this. */
    open(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
    /** Compare the unsynced collection with the open (ready) collection: what
     * would be created, what an earlier transfer already brought, what `map`
     * leaves out, renamed paths and types the destination lacks. Writes nothing. */
    planTransfer(options?: MdbaseTransferPlanOptions): Promise<MdbaseTransferPlan>;
    /** Create a plan's records in the open collection, keeping their IDs.
     * Interrupted? Plan and transfer again: only what is missing is created. */
    transfer(plan: MdbaseTransferPlan, options?: MdbaseTransferOptions): Promise<MdbaseTransferResult>;
    /** Erase the unsynced collection from this browser. Ask the person to
     * confirm first: it cannot be undone. A tab showing it continues in a new,
     * empty one. */
    discard(options?: MdbaseApplicationRequestOptions): Promise<MdbaseSnapshot>;
  };
}

/** Create the app's mdbase entry. Construction does no IO; `start()` begins. */
export function createMdbase(declaration: MdbaseApplicationDeclaration, options: MdbaseOptions = {}): Mdbase {
  return new MdbaseEntry(declaration, options).mdbase;
}
