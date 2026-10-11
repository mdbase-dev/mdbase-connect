/**
 * Setup for a Private collection opened through the relay. Hosted copies use
 * the same plan and review wording: `plan` reads the collection's definitions
 * through the app's own client and plans them with the native engine. `apply`
 * plans again, refuses `setup_changed` if anything moved, then writes every
 * change as one guarded mutation that the person's computer checks.
 */
import type { MdbaseClient } from "../client.js";
import { MdbaseError, mdbaseError } from "../errors.js";
import type { Op, Receipt } from "../wire.js";
import { resourceDecisions, type AppResourceAssessment, type AppResourceDecisions } from "../app-host/collection-control.js";
import type { AppSetupInventory } from "../app-host/setup-engine.js";
import type { ModelResourcePlan } from "../app-host/collection-setup-types.js";
import { setupPlan, setupRecords, type MdbaseSetupPlan, type MdbaseSetupPlanOptions, type MdbaseSetupRecord } from "../application/setup.js";

/** `ready`: nothing to do. `setup_required`: review and apply a plan. `incompatible`: blocked. */
export type MdbasePrivateSetupStatus = "ready" | "setup_required" | "incompatible";
export interface MdbasePrivateSetup {
  /** Check the collection without a review. Changes nothing. */
  assess(options?: { signal?: AbortSignal }): Promise<MdbasePrivateSetupStatus>;
  /** Plan setup for one review screen. Changes nothing; call again after any decision. */
  plan(options?: MdbaseSetupPlanOptions): Promise<MdbaseSetupPlan>;
  /** Apply a plan from `plan` unchanged, as one guarded mutation. Refuses
   * `setup_changed` if the collection changed since it was reviewed. */
  apply(plan: MdbaseSetupPlan, options?: { signal?: AbortSignal }): Promise<MdbasePrivateSetupStatus>;
}
/** @internal The native planner; the SDK's packaged runtime in production. */
export interface PrivateSetupEngine {
  assess(manifest: unknown, inventory: AppSetupInventory, decisions?: AppResourceDecisions): AppResourceAssessment;
  plan(manifest: unknown, expected: string, inventory: AppSetupInventory, decisions?: AppResourceDecisions): ModelResourcePlan;
}
/** @internal */
export interface PrivateSetupInput {
  readonly client: MdbaseClient;
  /** The app's compiled manifest DATA and declared operations. */
  readonly manifest: unknown;
  readonly operations: readonly string[];
  engine(signal: AbortSignal): Promise<PrivateSetupEngine>;
}

const changed = (mutationId?: string, cause?: unknown) => new MdbaseError(
  mdbaseError("conflict", "This collection changed since the setup was reviewed. Review it again.", "setup_changed").toProblem(),
  { ...(mutationId ? { mutationId } : {}), ...(cause === undefined ? {} : { cause }) });
const unavailable = () => mdbaseError("unavailable", "resource setup unavailable", "resource_setup_unavailable");
const status = (a: AppResourceAssessment): MdbasePrivateSetupStatus =>
  a.status === "current" ? "ready" : a.status === "conflict" ? "incompatible" : "setup_required";
const utf8 = new TextEncoder();

/** @internal Construction does no IO. */
export function privateCollectionSetup(input: PrivateSetupInput): MdbasePrivateSetup {
  const { client, manifest } = input;
  const declared = input.operations.includes("apply_collection_setup") || input.operations.includes("apply_type_pack");
  const plans = new WeakMap<MdbaseSetupPlan, { decisions: AppResourceDecisions; records: readonly MdbaseSetupRecord[] }>();

  /** Every confirmed definition, in path order; a pending one refuses. */
  async function inventory(signal?: AbortSignal): Promise<AppSetupInventory> {
    const rows: [string, string][] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.resources.list({ text: true, limit: 128, ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
      for (const r of page.resources) {
        if (r.state !== "confirmed" || typeof r.text !== "string" || utf8.encode(r.text).length !== r.size) throw unavailable();
        rows.push([r.path, r.text]);
      }
      if (page.complete) return rows;
      if (!page.cursor || page.cursor === cursor) throw unavailable();
      cursor = page.cursor;
    }
  }
  async function assessed(signal: AbortSignal | undefined, decisions?: AppResourceDecisions) {
    const engine = await input.engine(signal ?? new AbortController().signal);
    const rows = await inventory(signal);
    try {
      return { engine, rows, assessment: engine.assess(manifest, rows, decisions) };
    } catch (error) {
      // A reviewed adoption that no longer matches its row is a stale review.
      if (decisions?.adopt && Object.keys(decisions.adopt).length) throw changed(undefined, error);
      throw error;
    }
  }
  async function capabilities(signal?: AbortSignal) {
    return (await client.readyForRead(signal)).hello.grant.capabilities;
  }

  return Object.freeze({
    async assess(options: { signal?: AbortSignal } = {}) {
      return status((await assessed(options.signal)).assessment);
    },
    async plan(options: MdbaseSetupPlanOptions = {}) {
      const records = setupRecords(options.records);
      const decisions = resourceDecisions(options.adopt === undefined ? {} : { adopt: options.adopt });
      const { assessment } = await assessed(options.signal, decisions);
      if (!assessment.review) throw unavailable();
      const occupied: { path: string; free: boolean }[] = [];
      if (assessment.status !== "current") for (const r of records)
        occupied.push({ path: r.path, free: (await client.find({ path: r.path }, undefined, options.signal)) === null });
      const granted = await capabilities(options.signal);
      const result = setupPlan(assessment, { records: occupied,
        canManage: declared && granted.includes("definitions.manage"), canCreateRecords: granted.includes("records.create") });
      plans.set(result, Object.freeze({ decisions, records: records.filter(r => occupied.some(o => o.path === r.path && o.free)) }));
      return result;
    },
    async apply(reviewed: MdbaseSetupPlan, options: { signal?: AbortSignal } = {}) {
      const bound = plans.get(reviewed);
      if (!bound) throw new TypeError("setup.apply needs a plan returned by setup.plan");
      if (reviewed.refusal) throw mdbaseError(reviewed.refusal.code === "setup_conflict" ? "conflict" : "forbidden", reviewed.refusal.message, reviewed.refusal.code);
      const { engine, rows, assessment } = await assessed(options.signal, bound.decisions);
      if (assessment.assessmentDigest !== reviewed.digest) throw changed();
      if (assessment.status !== "provision") return status(assessment);
      const granted = await capabilities(options.signal);
      if (!declared || !granted.includes("definitions.manage") || (bound.records.length && !granted.includes("records.create")))
        throw mdbaseError("forbidden", "This app doesn't have permission to set up this collection.", "setup_forbidden");
      let plan: ModelResourcePlan;
      try { plan = engine.plan(manifest, assessment.assessmentDigest, rows, bound.decisions); } catch (error) { throw changed(undefined, error); }
      if (plan.assessmentDigest !== assessment.assessmentDigest || plan.sources.length) throw unavailable();
      // Starter records are create-only, in the same mutation as the definitions.
      const ops: Op[] = [...plan.resourceOps as readonly Op[],
        ...bound.records.map(r => ({ kind: "create" as const, id: crypto.randomUUID(), path: r.path, document: r.document }))];
      const writes = await client.submit(ops, { wait: "confirmed", ...(options.signal ? { signal: options.signal } : {}) });
      if (writes.length !== 1) throw unavailable();
      let receipt: Receipt;
      try { receipt = await writes[0]!.confirmed; } catch (error) {
        // A final rejection applied nothing: a guard saw a changed definition or path.
        if (writes[0]!.receipt.state === "rejected") throw changed(writes[0]!.mutationId, error);
        throw error;
      }
      if (receipt.state !== "confirmed" || receipt.status !== "applied" || (receipt.conflicts?.length ?? 0) !== 0) throw unavailable();
      const after = (await assessed(options.signal)).assessment;
      if (after.status !== "current") throw unavailable();
      return "ready";
    },
  });
}
