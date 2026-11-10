/** Bringing an unsynced collection's records into a synced collection (path B of
 * docs/architecture/work-before-connecting.md). Plain logic over two clients:
 * the SDK opens both, the app supplies only the optional `map`.
 *
 * Idempotent without a journal. Each record keeps its source UUID, and its
 * mutation ID comes from the intent `unsynced/1 \0 source \0 record` in the
 * destination, so a retry from any tab, after a reload or with a lost reply,
 * resends the same create. A record whose ID is already in the destination
 * came from an earlier transfer (IDs are random UUIDs) and is left as it is,
 * unless the ledger shows it changed here after it was brought in: then the
 * newer version is created beside it as a copy (never over the destination's,
 * which may have changed too), under an ID derived from the record and its
 * revision so a retry finds it. The destination's configuration and types are
 * never replaced; with `addTypes`, types it lacks are added from the source's
 * definitions. */
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
   * it in the destination. `skipped`: the app's map left it out. `changed`: an
   * earlier transfer put it in the destination and it has changed here since;
   * the newer version is created beside it as a copy. */
  readonly outcome: "create" | "present" | "skipped" | "changed";
  /** The destination path (`create` and `changed`). */
  readonly path?: string;
  /** The copy's ID (`changed` only); otherwise the record keeps `sourceId`. */
  readonly copyId?: string;
  /** The mapped path, when it was taken and `path` is a free one beside it. */
  readonly renamedFrom?: string;
}
export interface MdbaseTransferPlan {
  /** The unsynced collection. */
  readonly source: string;
  readonly destination: string;
  readonly items: readonly MdbaseTransferItem[];
  /** Types the records to create name that the destination does not define
   * and this transfer does not add. They are still created; the app may ask
   * the person to add the types, or plan again with `addTypes`. */
  readonly missingTypes: readonly string[];
  /** Types the transfer adds to the destination, from the source's own
   * definitions (`addTypes` only). */
  readonly addTypes: readonly string[];
  readonly counts: Readonly<{create: number; present: number; skipped: number; renamed: number; changed: number}>;
}
/** Which revision of each source record is in the destination, kept across
 * transfers from one source so a later change there is not mistaken for work
 * already brought in. Written before records are created. */
export interface MdbaseTransferLedger {
  read(source: string, signal?: AbortSignal): Promise<ReadonlyMap<string, string>>;
  record(source: string, revisions: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<void>;
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
  /** Types added to the destination (an existing one counts as added). */
  readonly addedTypes: readonly string[];
  /** Types that could not be added; their records were still created. */
  readonly failedTypes: readonly Readonly<{name: string; code: string}>[];
  /** Mutations submitted by this run, to follow until the destination confirms. */
  readonly mutations: readonly string[];
  /** Everything is in the destination, so the unsynced collection was kept
   * aside as a retired copy and the app starts afresh. False when something
   * failed, or another tab still works in it: transfer again to finish. */
  readonly retired: boolean;
}

type Source = Pick<MdbaseClient, "collection" | "pages" | "describe" | "resources">;
type Destination = Pick<MdbaseClient, "collection" | "get" | "create" | "describe" | "createType">;
/** Only plans made here can run: they carry the mapped inputs, and the map
 * that made them, privately. */
const prepared = new WeakMap<MdbaseTransferPlan, Readonly<{inputs: ReadonlyMap<string, CreateInput>; types: ReadonlyMap<string, string>; map: MdbaseTransferMap | undefined;
  ledger: MdbaseTransferLedger | undefined; settle: ReadonlyMap<string, string>}>>();
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
/** The copy of `record` at `revision`: the same ID on every retry. */
async function copyIdOf(record: string, revision: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`unsynced/1\0copy\0${record}\0${revision}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 version 8, variant 10
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function identity(record: RecordView): CreateInput {
  if (record.document === undefined) throw mdbaseError("invalid_request", "the source record has no document");
  return {path: record.path, document: record.document};
}

/** Compare the source with the destination. Nothing is written. */
export async function planUnsyncedTransfer(source: Source, destination: Destination,
  options: {readonly map?: MdbaseTransferMap; readonly addTypes?: boolean; readonly ledger?: MdbaseTransferLedger; readonly signal?: AbortSignal} = {}): Promise<MdbaseTransferPlan> {
  const {signal} = options, map = options.map ?? identity;
  if (source.collection === destination.collection) throw mdbaseError("invalid_request", "a collection cannot be transferred into itself");
  const moved = options.ledger ? await options.ledger.read(source.collection, signal) : new Map<string, string>();
  // The revisions this plan brings in, recorded before any create.
  const settle = new Map<string, string>();
  const described = await destination.describe(signal ? {signal} : {});
  const defined = new Set(described.types.map(t => t.name.toLowerCase()));
  const items: MdbaseTransferItem[] = [], inputs = new Map<string, CreateInput>(), claimed = new Set<string>(), missing = new Set<string>();
  let renames = 0;
  for await (const page of source.pages({}, {body: true, document: true}, signal)) {
    for (const record of page.records) {
      signal?.throwIfAborted();
      let copyId: string | null = null;
      if (await present(destination, record.id, signal)) {
        const known = moved.get(record.id);
        // Present before the ledger knew it (an earlier SDK, or another tab): what is there now counts as brought in.
        if (known === undefined) settle.set(record.id, record.revision);
        if (known === undefined || known === record.revision) { items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: "present"})); continue; }
        copyId = await copyIdOf(record.id, record.revision);
        if (await present(destination, copyId, signal)) {
          settle.set(record.id, record.revision);
          items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: "present"})); continue;
        }
      }
      const input = await map(record);
      if (input === null) { items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: "skipped"})); continue; }
      if (!input || typeof input !== "object" || (input.id !== undefined && input.id !== record.id)) throw mdbaseError("invalid_request", "the transfer map must keep the record ID");
      settle.set(record.id, record.revision);
      const wanted = input.path ?? record.path;
      let path = wanted;
      for (let n = 2; claimed.has(path.toLowerCase()) || await present(destination, {path}, signal); n++) {
        if (n > MAX_RENAME) throw mdbaseError("conflict", `no free path beside ${wanted}`, "path_taken");
        path = renamed(wanted, n);
      }
      claimed.add(path.toLowerCase());
      for (const type of input.type ? [input.type] : record.types) if (!defined.has(type.toLowerCase())) missing.add(type);
      inputs.set(record.id, Object.freeze({...input, id: copyId ?? record.id, path}));
      // A copy always lands beside the original; that is not a rename to report.
      if (path !== wanted && !copyId) renames++;
      items.push(Object.freeze({sourceId: record.id, sourcePath: record.path, outcome: copyId ? "changed" : "create", path,
        ...(copyId ? {copyId} : path !== wanted ? {renamedFrom: wanted} : {})}));
    }
  }
  // Types to add: those the source defines, read as its own type documents.
  const types = new Map<string, string>();
  if (options.addTypes && missing.size) {
    const own = new Map((await source.describe(signal ? {signal} : {})).types.map(t => [t.name.toLowerCase(), t] as const));
    for (const name of [...missing].sort()) {
      // Only a type with its own definition file (a type records merely name
      // has no revision) can be added.
      const type = own.get(name.toLowerCase());
      if (!type?.revision) continue;
      let text: string | undefined;
      try { text = (await source.resources.get(type.path, signal)).text; }
      catch (error) { if (isMdbaseError(error, "not_found")) continue; throw error; }
      if (typeof text === "string") { types.set(type.name, text); missing.delete(name); }
    }
  }
  const count = (outcome: MdbaseTransferItem["outcome"]) => items.filter(item => item.outcome === outcome).length;
  const plan: MdbaseTransferPlan = Object.freeze({source: source.collection, destination: destination.collection, items: Object.freeze(items),
    missingTypes: Object.freeze([...missing].sort()), addTypes: Object.freeze([...types.keys()].sort()),
    counts: Object.freeze({create: count("create"), present: count("present"), skipped: count("skipped"), renamed: renames, changed: count("changed")})});
  prepared.set(plan, Object.freeze({inputs, types, map: options.map, ledger: options.ledger, settle}));
  return plan;
}

/** After a run: whether planning again with the same map and ledger finds
 * nothing left to create (everything is present or left out by the map). */
export async function unsyncedTransferComplete(plan: MdbaseTransferPlan, source: Source, destination: Destination, signal?: AbortSignal): Promise<boolean> {
  const made = prepared.get(plan);
  if (!made) throw mdbaseError("invalid_request", "plan the transfer first");
  if (source.collection !== plan.source || destination.collection !== plan.destination) return false;
  const again = await planUnsyncedTransfer(source, destination, {...(made.map ? {map: made.map} : {}), ...(made.ledger ? {ledger: made.ledger} : {}), ...(signal ? {signal} : {})});
  return again.counts.create === 0 && again.counts.changed === 0;
}

/** Create the plan's records in the destination. Safe to run again with a
 * new plan after an interruption: only what is missing is created. */
export async function runUnsyncedTransfer(plan: MdbaseTransferPlan, destination: Destination,
  options: {readonly signal?: AbortSignal; readonly onProgress?: (progress: MdbaseTransferProgress) => void} = {}): Promise<MdbaseTransferResult> {
  const made = prepared.get(plan), {signal} = options;
  if (!made) throw mdbaseError("invalid_request", "plan the transfer first");
  const {inputs} = made;
  if (destination.collection !== plan.destination) throw mdbaseError("invalid_request", "the plan is for another collection");
  const work = plan.items.filter(item => item.outcome === "create" || item.outcome === "changed"), failed: {sourceId: string; code: string}[] = [], mutations: string[] = [];
  let created = 0, already = plan.counts.present, done = 0;
  const report = () => { try { options.onProgress?.(Object.freeze({done, total: work.length})); } catch { /* progress is advisory */ } };
  // The ledger first: a record created without it would later count as unchanged.
  if (made.ledger && made.settle.size) await made.ledger.record(plan.source, made.settle, signal);
  // Types first, so the records validate against them as they arrive.
  const addedTypes: string[] = [], failedTypes: {name: string; code: string}[] = [];
  for (const [name, document] of made.types) {
    signal?.throwIfAborted();
    try { await destination.createType(document, signal ? {signal} : {}); addedTypes.push(name); }
    catch (error) {
      signal?.throwIfAborted();
      // Added by an earlier run, or by someone else meanwhile.
      if (isMdbaseError(error, "conflict")) addedTypes.push(name);
      else failedTypes.push(Object.freeze({name, code: isMdbaseError(error) ? error.code : "unavailable"}));
    }
  }
  report();
  for (const item of work) {
    signal?.throwIfAborted();
    try {
      const write = await destination.create(inputs.get(item.sourceId)!, {intent: intentOf(plan.source, item.copyId ?? item.sourceId), ...(signal ? {signal} : {})});
      mutations.push(write.mutationId); created++;
    } catch (error) {
      signal?.throwIfAborted();
      // A lost reply, or another tab got there first: the record is there.
      if (await present(destination, item.copyId ?? item.sourceId, signal).catch(() => null)) already++;
      else failed.push(Object.freeze({sourceId: item.sourceId, code: isMdbaseError(error) ? error.code : "unavailable"}));
    }
    done++; report();
  }
  return Object.freeze({source: plan.source, destination: plan.destination, created, present: already, skipped: plan.counts.skipped,
    failed: Object.freeze(failed), addedTypes: Object.freeze(addedTypes), failedTypes: Object.freeze(failedTypes), mutations: Object.freeze(mutations), retired: false});
}
