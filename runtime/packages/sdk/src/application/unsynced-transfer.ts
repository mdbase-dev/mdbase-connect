/** Bringing an unsynced collection's records into a synced collection (path B of
 * docs/architecture/work-before-connecting.md). Plain logic over two clients:
 * the SDK opens both, the app supplies only the optional `map`.
 *
 * Idempotent without a journal. Each record keeps its source UUID, and its
 * mutation ID comes from the intent `unsynced/1 \0 source \0 record` in the
 * destination, so a retry from any tab, after a reload or with a lost reply,
 * resends the same create. A record whose ID is already in the destination
 * came from an earlier transfer (IDs are random UUIDs) and is left as it is.
 * The destination's configuration and types are never replaced. */
import type {CreateInput, MdbaseClient} from "../client.js";
import {isMdbaseError, mdbaseError} from "../errors.js";
import type {RecordView} from "../wire.js";

/** Map one source record to what to create, or null to leave it out. The
 * default keeps the record's path and complete source. */
export type MdbaseTransferMap = (record: RecordView) => CreateInput | null | Promise<CreateInput | null>;

export interface MdbaseTransferItem {
  readonly sourceId: string;
  readonly sourcePath: string;
  /** `create`: it will be created. `present`: an earlier transfer already put
   * it in the destination. `skipped`: the app's map left it out. */
  readonly outcome: "create" | "present" | "skipped";
  /** The destination path (`create` only). */
  readonly path?: string;
  /** The mapped path, when it was taken and `path` is a free one beside it. */
  readonly renamedFrom?: string;
}
export interface MdbaseTransferPlan {
  /** The unsynced collection. */
  readonly source: string;
  readonly destination: string;
  readonly items: readonly MdbaseTransferItem[];
  /** Types the records to create name that the destination does not define.
   * They are still created; the app may ask the person to add the types. */
  readonly missingTypes: readonly string[];
  readonly counts: Readonly<{create: number; present: number; skipped: number; renamed: number}>;
}
export interface MdbaseTransferProgress { readonly done: number; readonly total: number }
export interface MdbaseTransferResult {
  readonly source: string;
  readonly destination: string;
  readonly created: number;
  /** Already in the destination before this run (an earlier, interrupted run). */
  readonly present: number;
  readonly skipped: number;
  /** Not created. Transfer again to retry them: nothing already done repeats. */
  readonly failed: readonly Readonly<{sourceId: string; code: string}>[];
  /** Mutations submitted by this run, to follow until the destination confirms. */
  readonly mutations: readonly string[];
}

type Source = Pick<MdbaseClient, "collection" | "pages">;
type Destination = Pick<MdbaseClient, "collection" | "get" | "create" | "describe">;
/** Only plans made here can run: they carry the mapped inputs privately. */
const prepared = new WeakMap<MdbaseTransferPlan, ReadonlyMap<string, CreateInput>>();
const MAX_RENAME = 100;

const intentOf = (source: string, record: string) => `unsynced/1\0${source}\0${record}`;
async function present(destination: Destination, ref: string | {path: string}, signal: AbortSignal | undefined): Promise<RecordView | null> {
  try { return await destination.get(ref, undefined, signal); }
  catch (error) { if (isMdbaseError(error, "not_found")) return null; throw error; }
}
function renamed(path: string, n: number): string {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  const at = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0, at)} ${n}${path.slice(at)}`;
}
function identity(record: RecordView): CreateInput {
  if (record.document === undefined) throw mdbaseError("invalid_request", "the source record has no document");
  return {path: record.path, document: record.document};
}

/** Compare the source with the destination. Nothing is written. */
export async function planUnsyncedTransfer(source: Source, destination: Destination,
  options: {readonly map?: MdbaseTransferMap; readonly signal?: AbortSignal} = {}): Promise<MdbaseTransferPlan> {
  const {signal} = options, map = options.map ?? identity;
  if (source.collection === destination.collection) throw mdbaseError("invalid_request", "a collection cannot be transferred into itself");
  const described = await destination.describe(signal ? {signal} : {});
  const defined = new Set(described.types.map(t => t.name.toLowerCase()));
  const items: MdbaseTransferItem[] = [], inputs = new Map<string, CreateInput>(), claimed = new Set<string>(), missing = new Set<string>();
  let renames = 0;
  for await (const page of source.pages({}, {body: true, document: true}, signal)) {
    for (const record of page.records) {
      signal?.throwIfAborted();
      if (await present(destination, record.id, signal)) { items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: "present"})); continue; }
      const input = await map(record);
      if (input === null) { items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: "skipped"})); continue; }
      if (!input || typeof input !== "object" || (input.id !== undefined && input.id !== record.id)) throw mdbaseError("invalid_request", "the transfer map must keep the record ID");
      const wanted = input.path ?? record.path;
      let path = wanted;
      for (let n = 2; claimed.has(path.toLowerCase()) || await present(destination, {path}, signal); n++) {
        if (n > MAX_RENAME) throw mdbaseError("conflict", `no free path beside ${wanted}`, "path_taken");
        path = renamed(wanted, n);
      }
      claimed.add(path.toLowerCase());
      for (const type of input.type ? [input.type] : record.types) if (!defined.has(type.toLowerCase())) missing.add(type);
      inputs.set(record.id, Object.freeze({...input, id: record.id, path}));
      if (path !== wanted) renames++;
      items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: "create", path, ...(path !== wanted ? {renamedFrom: wanted} : {})}));
    }
  }
  const count = (outcome: MdbaseTransferItem["outcome"]) => items.filter(item => item.outcome === outcome).length;
  const plan: MdbaseTransferPlan = Object.freeze({source: source.collection, destination: destination.collection, items: Object.freeze(items),
    missingTypes: Object.freeze([...missing].sort()), counts: Object.freeze({create: count("create"), present: count("present"), skipped: count("skipped"), renamed: renames})});
  prepared.set(plan, inputs);
  return plan;
}

/** Create the plan's records in the destination. Safe to run again with a
 * new plan after an interruption: only what is missing is created. */
export async function runUnsyncedTransfer(plan: MdbaseTransferPlan, destination: Destination,
  options: {readonly signal?: AbortSignal; readonly onProgress?: (progress: MdbaseTransferProgress) => void} = {}): Promise<MdbaseTransferResult> {
  const inputs = prepared.get(plan), {signal} = options;
  if (!inputs) throw mdbaseError("invalid_request", "plan the transfer first");
  if (destination.collection !== plan.destination) throw mdbaseError("invalid_request", "the plan is for another collection");
  const work = plan.items.filter(item => item.outcome === "create"), failed: {sourceId: string; code: string}[] = [], mutations: string[] = [];
  let created = 0, already = plan.counts.present, done = 0;
  const report = () => { try { options.onProgress?.(Object.freeze({done, total: work.length})); } catch { /* progress is advisory */ } };
  report();
  for (const item of work) {
    signal?.throwIfAborted();
    try {
      const write = await destination.create(inputs.get(item.sourceId)!, {intent: intentOf(plan.source, item.sourceId), ...(signal ? {signal} : {})});
      mutations.push(write.mutationId); created++;
    } catch (error) {
      signal?.throwIfAborted();
      // A lost reply, or another tab got there first: the record is there.
      if (await present(destination, item.sourceId, signal).catch(() => null)) already++;
      else failed.push(Object.freeze({sourceId: item.sourceId, code: isMdbaseError(error) ? error.code : "unavailable"}));
    }
    done++; report();
  }
  return Object.freeze({source: plan.source, destination: plan.destination, created, present: already, skipped: plan.counts.skipped,
    failed: Object.freeze(failed), mutations: Object.freeze(mutations)});
}
