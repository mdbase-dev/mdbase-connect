/**
 * The headless collection view: one pure mapping from the SDK snapshot (whose
 * `phase` already says what state the app is in) to what the shared screens
 * show. No React, DOM or IO; the SDK owns state and problem copy, this module
 * only chooses headings, lists and which SDK call each control makes.
 */
import type { MdbaseErrorAction, MdbaseLinks, MdbasePhase, MdbaseProblem, MdbaseSnapshot } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";

import { defaultCollectionCopy, fill, type CollectionCopy } from "./copy.js";

export type CollectionRole = "owner" | "editor" | "viewer";

/** One approved collection, ready to render as a list row. */
export interface CollectionRow {
  readonly id: string;
  readonly name: string;
  /** Set when another listed collection has the same name. */
  readonly disambiguator: string | null;
  readonly role: CollectionRole;
  readonly roleLabel: string;
  /** The collection that is open, or opening. */
  readonly current: boolean;
  readonly available: boolean;
  /** Availability in a few words ("Your computer isn't online"), or null when available. */
  readonly status: string | null;
  /** The longer explanation for an unavailable collection. */
  readonly statusDetail: string | null;
}

/** What a problem's own button does. Every SDK action maps to one control or none. */
export type ProblemControl =
  | { readonly kind: "sign_in"; readonly label: string }
  | { readonly kind: "approve"; readonly label: string; readonly collectionId: string | null }
  | { readonly kind: "choose_another"; readonly label: string }
  | { readonly kind: "set_up"; readonly label: string }
  | { readonly kind: "assess"; readonly label: string }
  | { readonly kind: "start"; readonly label: string }
  | { readonly kind: "reload"; readonly label: string }
  | { readonly kind: "link"; readonly label: string; readonly href: string };

/** A described problem plus its control. `title`/`message` are the SDK's copy. */
export interface CollectionNotice {
  readonly key: string;
  readonly tone: "info" | "warning" | "error";
  readonly title: string | null;
  readonly message: string;
  readonly control: ProblemControl | null;
  /** The SDK clears it by itself (busy, migrating): show it quietly. */
  readonly transient: boolean;
}

interface Common {
  /** The gate's heading for this phase (never an SDK problem title). */
  readonly heading: string;
  readonly lead: string | null;
  /** Signed in to mdbase on this device. */
  readonly signedIn: boolean;
  /** "Signed in as …" label, or null when not signed in (or the account has no label). */
  readonly account: string | null;
  /** Every approved collection, current first then by name. */
  readonly collections: readonly CollectionRow[];
  readonly current: CollectionRow | null;
  readonly links: MdbaseLinks | null;
  /** True when "Choose a different collection" leaves something open or requested. */
  readonly canChooseAnother: boolean;
}

export type CollectionView = Common & (
  | { readonly kind: "starting" }
  | { readonly kind: "signed_out"; readonly notice: CollectionNotice | null }
  | { readonly kind: "authorizing"; readonly purpose: "sign_in" | "add" | "approve"; readonly collectionId: string | null }
  | { readonly kind: "choosing"; readonly notice: CollectionNotice | null }
  | { readonly kind: "opening"; readonly collectionId: string; readonly slow: boolean }
  | { readonly kind: "needs_approval"; readonly collectionId: string; readonly declined: boolean }
  | { readonly kind: "needs_setup"; readonly collectionId: string }
  | { readonly kind: "problem"; readonly collectionId: string | null; readonly notice: CollectionNotice }
  | { readonly kind: "ready"; readonly collectionId: string; readonly phase: Extract<MdbasePhase, { kind: "ready" }>; readonly notice: CollectionNotice | null }
  | { readonly kind: "unavailable"; readonly notice: CollectionNotice }
  | { readonly kind: "closed" }
);
export type CollectionViewKind = CollectionView["kind"];

export interface CollectionViewOptions {
  /** The app's name, as people know it ("TaskNotes"). */
  readonly appName: string;
  readonly copy?: Partial<CollectionCopy> | undefined;
}

type Snapshot = Pick<MdbaseSnapshot, "phase" | "collections" | "signIn" | "selection" | "links" | "readiness" | "status"> &
  Partial<Pick<MdbaseSnapshot, "signOutResult" | "selectedCollectionId">>;

/** Map an SDK snapshot to the screen to show. */
export function collectionView(snapshot: Snapshot, options: CollectionViewOptions): CollectionView {
  const copy = { ...defaultCollectionCopy, ...options.copy };
  const app = options.appName;
  const phase = snapshot.phase;
  const currentId = currentCollectionId(phase);
  const collections = collectionRows(snapshot.collections, currentId, copy);
  const current = collections.find((row) => row.current) ?? null;
  const nameOf = (id: string | null, fallback: string | null = null): string | null =>
    (id && collections.find((row) => row.id === id)?.name) || fallback;
  const signedIn = snapshot.signIn?.state === "paired";
  const say = (template: string, collection?: string | null) => fill(template, { app, collection: collection ?? "" });
  const common = {
    signedIn,
    account: signedIn ? accountLabel(snapshot.signIn) : null,
    collections,
    current,
    links: snapshot.links ?? null,
    canChooseAnother: signedIn && (currentId !== null || (snapshot.selection.requested.collectionId ?? null) !== null),
  };

  switch (phase.kind) {
    case "starting":
      return { ...common, kind: "starting", heading: say(copy.startingHeading), lead: null };
    case "signed_out": {
      const signedOut = snapshot.signOutResult ?? null;
      const notice = phase.notice ? quietNotice(phase.notice)
        : signedOut ? {
          key: "signed_out", tone: "info" as const, title: null, control: null, transient: false,
          message: signedOut.server === "incomplete" ? `${say(copy.signedOutNotice)} ${copy.signedOutIncomplete}` : say(copy.signedOutNotice),
        } : null;
      return { ...common, kind: "signed_out", heading: say(copy.signedOutHeading), lead: say(copy.signedOutLead), notice };
    }
    case "authorizing": {
      const name = nameOf(phase.collectionId, snapshot.selection.requested.displayName) ?? copy.thisCollection;
      const lead = phase.purpose === "sign_in" ? copy.authorizingSignIn : phase.purpose === "add" ? copy.authorizingAdd : copy.authorizingApprove;
      return { ...common, kind: "authorizing", purpose: phase.purpose, collectionId: phase.collectionId,
        heading: say(copy.authorizingHeading), lead: say(lead, name) };
    }
    case "choosing": {
      const empty = collections.length === 0;
      return { ...common, kind: "choosing", notice: approvalNotice(phase.lastApproval, copy),
        heading: say(empty ? copy.emptyHeading : copy.chooseHeading), lead: empty ? say(copy.emptyLead) : null };
    }
    case "opening": {
      const name = nameOf(phase.collectionId, phase.displayName);
      return { ...common, kind: "opening", collectionId: phase.collectionId, slow: phase.slow,
        heading: name ? say(copy.openingHeading, name) : say(copy.openingHeadingUnnamed), lead: phase.slow ? say(copy.openingSlow) : null };
    }
    case "needs_approval": {
      const name = nameOf(phase.collectionId, phase.displayName);
      return { ...common, kind: "needs_approval", collectionId: phase.collectionId, declined: phase.declined,
        heading: name ? say(copy.approvalHeading, name) : say(copy.approvalHeadingUnnamed),
        lead: say(phase.declined ? copy.approvalDeclined : copy.approvalLead) };
    }
    case "needs_setup": {
      const name = nameOf(phase.collectionId, phase.collection.displayName);
      return { ...common, kind: "needs_setup", collectionId: phase.collectionId, heading: say(copy.setupHeading, name), lead: say(copy.setupLead) };
    }
    case "problem": {
      const name = nameOf(phase.collectionId, snapshot.selection.requested.displayName);
      const notice = problemNotice(phase.problem, { collectionId: phase.collectionId, signedIn, open: isOpen(snapshot) });
      return { ...common, kind: "problem", collectionId: phase.collectionId, notice,
        heading: name ? say(copy.problemHeading, name) : say(copy.problemHeadingUnnamed), lead: null };
    }
    case "ready":
      return { ...common, kind: "ready", collectionId: phase.collectionId, phase,
        notice: phase.problem ? problemNotice(phase.problem, { collectionId: phase.collectionId, signedIn, open: true }) : null,
        heading: phase.collection.displayName, lead: null };
    case "unavailable":
      return { ...common, kind: "unavailable", notice: problemNotice(phase.problem, { collectionId: null, signedIn: false, open: false }),
        heading: say(copy.unavailableHeading), lead: null };
    case "closed":
      return { ...common, kind: "closed", heading: say(copy.closedHeading), lead: say(copy.closedLead) };
  }
}

/** The SDK's description of a failed action, as an inline notice (no control: the person clicks again). */
export function actionNotice(problem: MdbaseProblem | null): CollectionNotice | null {
  return problem ? quietNotice(problem) : null;
}

function quietNotice(problem: MdbaseProblem): CollectionNotice {
  return { key: problem.key, tone: problem.severity, title: problem.title, message: problem.message, control: null, transient: problem.transient };
}

function problemNotice(problem: MdbaseProblem, context: { collectionId: string | null; signedIn: boolean; open: boolean }): CollectionNotice {
  return { ...quietNotice(problem), control: problemControl(problem, context) };
}

/** One control per SDK action; `wait`, `none` and actions with nowhere to go get none. */
export function problemControl(
  problem: Pick<MdbaseProblem, "action" | "actionLabel" | "updateUrl">,
  context: { collectionId: string | null; signedIn: boolean; open: boolean }
): ProblemControl | null {
  const label = problem.actionLabel;
  if (!label) return null;
  const action: MdbaseErrorAction = problem.action;
  switch (action) {
    case "sign_in": return { kind: "sign_in", label };
    case "approve": return { kind: "approve", label, collectionId: context.collectionId };
    case "choose_collection": return context.signedIn ? { kind: "choose_another", label } : null;
    case "set_up": return context.open ? { kind: "set_up", label } : null;
    case "update_app": return problem.updateUrl ? { kind: "link", label, href: problem.updateUrl } : null;
    case "retry":
    case "check_connection": return context.open ? { kind: "assess", label } : { kind: "start", label };
    case "resolve_outcome": return { kind: "start", label };
    case "reload": return { kind: "reload", label };
    case "wait":
    case "free_space":
    case "contact_support":
    case "none": return null;
  }
}

function approvalNotice(outcome: Extract<MdbasePhase, { kind: "choosing" }>["lastApproval"], copy: CollectionCopy): CollectionNotice | null {
  if (!outcome || outcome.outcome === "added" || outcome.outcome === "unchanged") return null;
  const message = outcome.kind === "add" ? copy.noCollectionAdded : copy.accessNotGiven;
  return { key: `approval_${outcome.outcome}`, tone: "info", title: null, message, control: null, transient: false };
}

function currentCollectionId(phase: MdbasePhase): string | null {
  switch (phase.kind) {
    case "opening":
    case "needs_setup":
    case "ready": return phase.collectionId;
    case "problem": return phase.collectionId;
    default: return null;
  }
}

function isOpen(snapshot: Snapshot): boolean {
  return snapshot.status === "ready" || snapshot.status === "setup_required";
}

const roleLabels = (copy: CollectionCopy): Record<CollectionRole, string> =>
  ({ owner: copy.roleOwner, editor: copy.roleEditor, viewer: copy.roleViewer });

/** Rows for the approved collections: current first, then by name; equal names get an ID hint. */
export function collectionRows(
  collections: MdbaseSnapshot["collections"],
  currentId: string | null,
  copy: CollectionCopy = defaultCollectionCopy
): CollectionRow[] {
  const counts = new Map<string, number>();
  for (const c of collections) counts.set(c.displayName.trim().toLocaleLowerCase(), (counts.get(c.displayName.trim().toLocaleLowerCase()) ?? 0) + 1);
  const roles = roleLabels(copy);
  const rows = collections.map((c): CollectionRow => {
    const availability = c.availability ?? { state: "available" as const };
    const unavailable = availability.state === "unavailable";
    const described = unavailable ? describeError(availability) : null;
    return {
      id: c.collectionId,
      name: c.displayName,
      disambiguator: (counts.get(c.displayName.trim().toLocaleLowerCase()) ?? 0) > 1 ? fill(copy.idHint, { id: c.collectionId.slice(0, 8) }) : null,
      role: c.role,
      roleLabel: roles[c.role],
      current: c.collectionId === currentId,
      available: !unavailable,
      status: availability.state === "opening" ? copy.rowOpening : described?.title ?? null,
      statusDetail: described?.message ?? null,
    };
  });
  return rows.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** "someone@example.com", or "octocat on GitHub". */
export function accountLabel(signIn: MdbaseSnapshot["signIn"]): string | null {
  if (!signIn) return null;
  if (signIn.accountEmail) return signIn.accountEmail;
  if (signIn.accountProvider === "github" && signIn.accountLogin) return `${signIn.accountLogin} on GitHub`;
  return null;
}
