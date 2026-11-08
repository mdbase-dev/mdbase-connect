/**
 * Work before connecting: the SDK's `unsynced` phase, `snapshot.unsyncedWork`
 * and `mdbase.unsynced`, read structurally so this package keeps building
 * against SDK releases that predate them (where they are simply absent).
 */
import type { CreateInput, Mdbase, MdbaseApplicationConnection, MdbasePhase, RecordView } from "@mdbase-dev/sdk";

/** The tab shows the app's unsynced collection: saved only on this device. */
export interface UnsyncedPhase {
  readonly kind: "unsynced";
  readonly collectionId: string;
  readonly connection: MdbaseApplicationConnection;
  readonly rechecking: boolean;
}

/** Reshape or leave out (null) a record when bringing work in; it must keep its ID. */
export type UnsyncedTransferMap = (record: RecordView) => CreateInput | null | Promise<CreateInput | null>;

export interface UnsyncedPlan {
  readonly destination: string;
  readonly counts: Readonly<{ create: number; present: number; skipped: number; renamed: number }>;
  readonly missingTypes: readonly string[];
  readonly addTypes?: readonly string[];
}

export interface UnsyncedResult {
  readonly failed: readonly unknown[];
  readonly failedTypes?: readonly unknown[];
  readonly retired?: boolean;
}

interface UnsyncedApi {
  open(options?: { signal?: AbortSignal }): Promise<unknown>;
  planTransfer(options?: { map?: UnsyncedTransferMap; addTypes?: boolean; signal?: AbortSignal }): Promise<UnsyncedPlan>;
  transfer(plan: UnsyncedPlan, options?: { signal?: AbortSignal }): Promise<UnsyncedResult>;
  discard(options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** `mdbase.unsynced`, or null on an SDK without it. */
export function unsyncedApi(mdbase: Mdbase): UnsyncedApi | null {
  const api = (mdbase as { readonly unsynced?: Partial<UnsyncedApi> }).unsynced;
  return api && typeof api.open === "function" && typeof api.planTransfer === "function" && typeof api.transfer === "function" && typeof api.discard === "function"
    ? api as UnsyncedApi : null;
}

export function unsyncedPhase(phase: MdbasePhase): UnsyncedPhase | null {
  const value = phase as unknown as Partial<UnsyncedPhase> & { readonly kind: string };
  return value.kind === "unsynced" && typeof value.collectionId === "string" && value.connection ? value as UnsyncedPhase : null;
}

/** Something has been saved in the unsynced collection and not yet brought in. */
export function hasUnsyncedWork(snapshot: object): boolean {
  const work = (snapshot as { readonly unsyncedWork?: unknown }).unsyncedWork;
  return typeof work === "object" && work !== null;
}

/** Whether bringing this plan in has something for the person to decide first. */
export function planNeedsReview(plan: UnsyncedPlan): boolean {
  return plan.counts.renamed > 0 || (plan.addTypes?.length ?? 0) > 0 || plan.missingTypes.length > 0;
}
