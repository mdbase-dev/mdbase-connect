/**
 * The one derived state model (R1). `applicationPhase` maps the raw snapshot
 * (sign-in status, selection, readiness) to a single phase, so the shared UI
 * and apps never hand-roll a "ready" check. Pure: no IO, timers or globals.
 *
 * Rules:
 * - `ready` needs a current connection for the usable collection; without one
 *   the collection is still `opening`.
 * - Once `ready`, a collection stays `ready` through re-checks, busy/changed
 *   results and other transient problems (`rechecking`, `problem` carry them).
 *   Only a settled non-ready outcome (setup needed, incompatible, approval
 *   lost), a durable problem, or a different/cleared selection replaces it.
 */
import { describeError, type MdbaseErrorDescription } from "../describe-error.js";
import type { ApplicationApprovalOutcome } from "./collection-selection.js";
import type { AppInstallationCollection } from "../app-host/installation-sign-in.js";
import type { MdbaseApplicationConnection, MdbaseApplicationSnapshot, MdbaseUnavailableType } from "./entry.js";

/** A described problem: plain copy plus one typed action (see describeError). */
export type MdbaseProblem = MdbaseErrorDescription;
/** One collection this app may open, as listed in `snapshot.collections`. */
export type MdbaseCollectionSummary = AppInstallationCollection;

/** SDK-6: how the last `approve()` ended (`added`, `unchanged`, `declined`, `closed`). */
export type MdbaseApprovalOutcome = ApplicationApprovalOutcome;

export type MdbasePhase =
  /** The SDK is starting: show the app's wordmark or the cached list. */
  | { readonly kind: "starting" }
  /** Not signed in. `notice` explains why when sign-in just ended (window closed, signed out). */
  | { readonly kind: "signed_out"; readonly notice: MdbaseProblem | null }
  /** Waiting for the Connect window: sign in, add a collection or approve one. */
  | { readonly kind: "authorizing"; readonly purpose: "sign_in" | "add" | "approve"; readonly collectionId: string | null }
  /** Signed in, nothing open: choose from `snapshot.collections` or add one. */
  | { readonly kind: "choosing"; readonly lastApproval: MdbaseApprovalOutcome | null }
  /** SDK-9: `slow` turns on when opening takes longer than usual. */
  | { readonly kind: "opening"; readonly collectionId: string; readonly displayName: string | null; readonly slow: boolean; readonly progress?: import("../app-host/opening-progress.js").AppOpeningProgress | null }
  /** The requested collection is not approved for this app (yet). */
  | { readonly kind: "needs_approval"; readonly collectionId: string; readonly displayName: string | null; readonly declined: boolean }
  /** Open, but needs a one-time setup: `setup.plan()` then `setup.apply(plan)`. */
  | { readonly kind: "needs_setup"; readonly collectionId: string; readonly collection: MdbaseCollectionSummary }
  /** Open and usable. `rechecking` and `problem` are informational only. */
  | { readonly kind: "ready"; readonly collectionId: string; readonly collection: MdbaseCollectionSummary; readonly connection: MdbaseApplicationConnection;
      readonly rechecking: boolean; readonly problem: MdbaseProblem | null; readonly unavailableTypes: readonly MdbaseUnavailableType[] }
  /** Can't continue: show `problem` with its action. */
  | { readonly kind: "problem"; readonly collectionId: string | null; readonly problem: MdbaseProblem }
  /** The SDK can't run here (SSR, Node, an unsupported browser). */
  | { readonly kind: "unavailable"; readonly problem: MdbaseProblem }
  | { readonly kind: "closed" };
export type MdbasePhaseKind = MdbasePhase["kind"];

/** Opening longer than this reads `slow` (SDK-9). */
export const SLOW_OPENING_MS = 15_000;

export interface ApplicationPhaseOptions {
  /** The connection for the usable collection (entry.connection(id)). */
  readonly connection?: MdbaseApplicationConnection | null;
  /** The previous phase: keeps `ready` through transient states. */
  readonly previous?: MdbasePhase | null;
  /** Set when the current opening has lasted SLOW_OPENING_MS. */
  readonly slow?: boolean;
  readonly cpOrigin?: string;
}

type Snapshot = Pick<MdbaseApplicationSnapshot, "status" | "signIn" | "collections" | "selectedCollectionId" | "problem" | "readiness" | "selection"> & Partial<Pick<MdbaseApplicationSnapshot, "problemDetail" | "removedScopeIds" | "recoveryAccountLabel" | "openingProgress">>;

const current = (c: MdbaseApplicationConnection | null | undefined, id: string): c is MdbaseApplicationConnection => {
  try { return !!c && c.id === id && c.isCurrent(); } catch { return false; }
};
const describe = (input: unknown, cpOrigin?: string): MdbaseProblem | null => describeError(input, cpOrigin ? { cpOrigin } : {});
const fallback = (code: string, cpOrigin?: string): MdbaseProblem => describe(code, cpOrigin)!;

/** Derive the phase of a public application snapshot. */
export function applicationPhase(s: Snapshot, options: ApplicationPhaseOptions = {}): MdbasePhase {
  const next = derive(s, options);
  const phase = hold(next, s, options);
  return phase.kind === "opening" && s.status === "opening" && s.selectedCollectionId === phase.collectionId && s.openingProgress
    ? { ...phase, progress: s.openingProgress } : phase;
}

function derive(s: Snapshot, o: ApplicationPhaseOptions): MdbasePhase {
  const cp = o.cpOrigin, sel = s.selection, requested = sel?.requested ?? null;
  if (s.status === "closed") return { kind: "closed" };
  if (s.problem === "application_not_yet_available" || s.problem === "application_worker_unavailable" || s.problem === "browser_unsupported" || s.problem === "application_storage_unavailable") return { kind: "unavailable", problem: fallback(s.problem, cp) };
  if (sel?.state === "invalid") return { kind: "problem", collectionId: null, problem: fallback(sel.problem ?? "application_selection_invalid", cp) };
  const paired = s.signIn?.state === "paired";
  if (sel?.state === "approving" || s.status === "authorizing") {
    // Signing in shows the sign-in window; a paired session is adding or approving.
    const approval = sel?.approval ?? null;
    if (!paired) return { kind: "authorizing", purpose: "sign_in", collectionId: approval?.collectionId ?? requested?.collectionId ?? null };
    return approval?.kind === "add" ? { kind: "authorizing", purpose: "add", collectionId: null }
      : { kind: "authorizing", purpose: "approve", collectionId: approval?.collectionId ?? requested?.collectionId ?? null };
  }
  if (s.status === "not_started" || s.status === "starting") {
    // A returning user with a remembered request goes straight to opening (P4).
    const id = requested?.collectionId ?? null;
    return id && s.status === "starting" ? { kind: "opening", collectionId: id, displayName: requested?.displayName ?? null, slow: !!o.slow } : { kind: "starting" };
  }
  if (s.status === "signed_out") return { kind: "signed_out", notice: s.problem ? describe(s, cp) : null };
  if (s.status === "blocked") {
    const id = s.selectedCollectionId ?? requested?.collectionId ?? null;
    if (s.problem === "recovery_account_mismatch") return {kind: "problem", collectionId: id, problem: describeError(s, {cpOrigin: cp, recoveryAccountLabel: s.recoveryAccountLabel})!};
    return { kind: "problem", collectionId: id, problem: id && s.removedScopeIds?.includes(id) ? fallback("installation_scope_removed", cp) : describe(s, cp) ?? fallback("open_failed", cp) };
  }
  if (sel?.state === "approval_required" && requested?.collectionId && s.removedScopeIds?.includes(requested.collectionId))
    return {kind: "problem", collectionId: requested.collectionId, problem: fallback("installation_scope_removed", cp)};
  if (sel?.state === "approval_required" && requested?.collectionId)
    return { kind: "needs_approval", collectionId: requested.collectionId, displayName: requested.displayName, declined: sel.problem === "application_selection_not_approved" };
  if (sel?.state === "pending" && requested?.collectionId)
    return { kind: "opening", collectionId: requested.collectionId, displayName: requested.displayName, slow: !!o.slow };
  const usable = sel?.usable ?? (s.status === "ready" || s.status === "setup_required" ? s.collections.find(c => c.collectionId === s.selectedCollectionId) ?? null : null);
  if (s.status === "setup_required" && usable) {
    // Settled setup outcomes: incompatible collections are problems, not setup.
    if (s.readiness.assessment?.status === "incompatible") return { kind: "problem", collectionId: usable.collectionId, problem: describe(s.readiness, cp) ?? fallback("incompatible", cp) };
    return { kind: "needs_setup", collectionId: usable.collectionId, collection: usable };
  }
  if (s.status === "ready" && usable && current(o.connection, usable.collectionId)) {
    return { kind: "ready", collectionId: usable.collectionId, collection: usable, connection: o.connection, rechecking: s.readiness.checking,
      problem: null, unavailableTypes: s.readiness.assessment?.unavailableTypes ?? [] };
  }
  const opening = s.status === "opening" || s.status === "ready" || sel?.state === "opening" || sel?.state === "usable";
  const id = s.selectedCollectionId ?? requested?.collectionId ?? null;
  if (opening && id) {
    const name = s.collections.find(c => c.collectionId === id)?.displayName ?? requested?.displayName ?? null;
    return { kind: "opening", collectionId: id, displayName: name, slow: !!o.slow };
  }
  return { kind: "choosing", lastApproval: sel?.lastApproval ?? null };
}

/** Never demote READY for transient states of the SAME open collection. */
function hold(next: MdbasePhase, s: Snapshot, o: ApplicationPhaseOptions): MdbasePhase {
  const prev = o.previous;
  // Applying setup re-checks the collection. Keep the setup screen through it,
  // so the setup review stays mounted and can show the apply's outcome or
  // failure, rather than an "opening" screen that drops it.
  if (prev?.kind === "needs_setup" && next.kind === "opening" && next.collectionId === prev.collectionId &&
      s.selectedCollectionId === prev.collectionId && s.readiness.checking) return prev;
  if (!prev || prev.kind !== "ready" || next.kind === "ready" || !current(o.connection, prev.collectionId)) return next;
  // The same collection is still the one the session has selected.
  if (s.selectedCollectionId !== prev.collectionId) return next;
  if (next.kind === "opening" && next.collectionId === prev.collectionId)
    return { ...prev, connection: o.connection!, rechecking: true, problem: null };
  if (next.kind === "problem" && next.problem.transient)
    return { ...prev, connection: o.connection!, rechecking: true, problem: next.problem };
  return next;
}

/** True when the phase is ready for this collection with a current connection. */
export function isReadyPhase(phase: MdbasePhase | null | undefined, collectionId?: string): phase is Extract<MdbasePhase, { kind: "ready" }> {
  return phase?.kind === "ready" && (collectionId === undefined || phase.collectionId === collectionId);
}
