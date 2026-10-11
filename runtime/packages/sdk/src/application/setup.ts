/** Reviewable collection setup: one plan for one review screen, then one
 * guarded all-or-nothing apply. Native Core plans; the SDK only words it. */
import type { AppResourceAssessment, AppResourceReview } from "../app-host/collection-control.js";
import type { MdbaseApplicationRequestOptions, MdbaseApplicationSnapshot } from "./entry.js";

/** A starter record created once, in the same mutation as the first setup. */
export interface MdbaseSetupRecord {
  /** Collection path, e.g. `Welcome.md`. An occupied path is left alone. */
  readonly path: string;
  /** The complete Markdown document, frontmatter included. */
  readonly document: string;
}
export interface MdbaseSetupPlanOptions extends MdbaseApplicationRequestOptions {
  /** Reviewed adoptions from an earlier plan's `adoptable`: target → digest. */
  readonly adopt?: Readonly<Record<string, string>>;
  /** Starter records, created only if setup runs and their path is free.
   * Verified afterwards by identity, path and confirmation, not exact bytes. */
  readonly records?: readonly MdbaseSetupRecord[];
}
export type MdbaseSetupChangeKind = "create" | "update" | "delete" | "adopt" | "setting" | "record";
/** One line of the review screen. `message` is written to be shown as is. */
export interface MdbaseSetupChange {
  readonly kind: MdbaseSetupChangeKind;
  /** Collection path, or the setting's name for `setting`. */
  readonly target: string;
  readonly message: string;
}
export interface MdbaseSetupConflict {
  readonly target: string;
  readonly message: string;
  /** Present when using the app's version resolves it: pass via `adopt`. */
  readonly adoptable?: { readonly digest: string };
}
export type MdbaseSetupRefusalCode = "setup_forbidden" | "setup_conflict" | "setup_downgrade" | "setup_records_forbidden";
export interface MdbaseSetupPlan {
  /** `current`: nothing to do. `setup`: changes to apply. `conflict`: blocked. */
  readonly status: "current" | "setup" | "conflict";
  readonly canApply: boolean;
  /** Binds the reviewed collection state and decisions. */
  readonly digest: string;
  /** One plain sentence for the top of the review screen. */
  readonly summary: string;
  readonly changes: readonly MdbaseSetupChange[];
  readonly conflicts: readonly MdbaseSetupConflict[];
  /** Conflicts that using the app's version would resolve: pass as `adopt` and plan again. */
  readonly adoptable: Readonly<Record<string, string>>;
  readonly packs: readonly { readonly id: string; readonly version: string; readonly status: AppResourceReview["packs"][number]["status"]; readonly installedVersion?: string }[];
  /** The definition documents setup would write, for a details view. */
  readonly staged: readonly { readonly path: string; readonly document: string }[];
  /** Starter records: `create` is written with the setup, `skip` already exists. */
  readonly records: readonly { readonly path: string; readonly action: "create" | "skip" }[];
  readonly refusal?: { readonly code: MdbaseSetupRefusalCode; readonly message: string };
}
export interface MdbaseApplicationSetup {
  /** Plan setup of the open collection. Changes no collection data (it may
   * settle the local journal of an earlier apply); call again after any decision. */
  plan(options?: MdbaseSetupPlanOptions): Promise<MdbaseSetupPlan>;
  /** Apply a plan from `plan` unchanged, as one guarded mutation. Refuses
   * `setup_changed` if the collection changed since it was reviewed. */
  apply(plan: MdbaseSetupPlan, options?: MdbaseApplicationRequestOptions): Promise<MdbaseApplicationSnapshot>;
}

const MAX_RECORDS = 32, MAX_RECORD_BYTES = 256 * 1024;
const name = (target: string) => (target.split("/").pop() ?? target).replace(/\.(md|ya?ml|json)$/i, "");
const noun = (kind: string) => kind === "type" ? "record type" : kind === "schema" ? "schema" : kind === "contract" ? "contract" : "definition";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const setting = (path: string) => (path.split("/").filter(Boolean).pop() ?? path).replace(/[_-]+/g, " ");

export function setupRecords(records: unknown): readonly MdbaseSetupRecord[] {
  if (records === undefined) return Object.freeze([]);
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new TypeError("setup records: at most 32 { path, document } entries");
  const seen = new Set<string>(), utf8 = new TextEncoder();
  let bytes = 0;
  return Object.freeze(records.map(r => {
    const path = (r as MdbaseSetupRecord)?.path, document = (r as MdbaseSetupRecord)?.document;
    if (typeof path !== "string" || !/\.md$/i.test(path) || path.length > 1024 || path.startsWith("/") || path.split("/").some(s => !s || s === "." || s === "..")
      || seen.has(path.toLowerCase()) || typeof document !== "string" || !document.length
      || (bytes += utf8.encode(document).length + utf8.encode(path).length) > MAX_RECORD_BYTES)
      throw new TypeError("setup records: each needs a unique relative .md path and a document (256 KiB in total)");
    seen.add(path.toLowerCase());
    return Object.freeze({ path, document });
  }));
}

/** Word native Core's review for a first-run user. No raw codes in messages. */
export function setupPlan(assessed: AppResourceAssessment, input: {
  readonly canManage: boolean; readonly canCreateRecords: boolean;
  readonly records: readonly { readonly path: string; readonly free: boolean }[];
}): MdbaseSetupPlan {
  const review = assessed.review!;
  const status = assessed.status === "current" ? "current" as const : assessed.status === "conflict" ? "conflict" as const : "setup" as const;
  const changes: MdbaseSetupChange[] = [], conflicts: MdbaseSetupConflict[] = [], adoptable: Record<string, string> = {};
  for (const pack of review.packs) for (const r of pack.resources) {
    const thing = `the "${name(r.target)}" ${noun(r.kind)}`;
    switch (r.action) {
      case "create": changes.push({ kind: "create", target: r.target, message: `Add ${thing}.` }); break;
      case "update": changes.push({ kind: "update", target: r.target, message: `Update ${thing}.` }); break;
      case "delete": changes.push({ kind: "delete", target: r.target, message: `Remove ${thing}, which this app no longer uses.` }); break;
      case "adopt": changes.push({ kind: "adopt", target: r.target, message: `Replace your existing ${thing.slice(4)} with this app's version.` }); break;
      case "conflict": {
        const canAdopt = r.mode === "managed" && !r.installed && r.currentDigest !== undefined;
        if (canAdopt) adoptable[r.target] = r.currentDigest!;
        conflicts.push({ target: r.target, ...(canAdopt ? { adoptable: { digest: r.currentDigest! } } : {}),
          message: canAdopt ? `This collection already has a ${thing.slice(4)} that differs from the one this app needs. You can replace it with this app's version.`
            : r.installed ? `${thing[0]!.toUpperCase()}${thing.slice(1)} was changed after this app set it up, so it can't be updated automatically.`
              : `${thing[0]!.toUpperCase()}${thing.slice(1)} can't be set up automatically.` });
        break;
      }
      default: break;
    }
  }
  for (const c of review.configuration) {
    const label = setting(c.path);
    if (c.action === "add") changes.push({ kind: "setting", target: label,
      message: typeof c.value === "string" ? `Add "${c.value}" to the collection's ${label} setting.` : `Change the collection's ${label} setting.` });
    else conflicts.push({ target: label, message: `The collection's ${label} setting has an unexpected value, so it can't be changed automatically.` });
  }
  const records = status === "current" ? [] : input.records.map(r => Object.freeze({ path: r.path, action: r.free ? "create" as const : "skip" as const }));
  for (const r of records) if (r.action === "create") changes.push({ kind: "record", target: r.path, message: `Create the starter note "${name(r.path)}".` });
  const downgrade = review.packs.some(p => p.status === "downgrade");
  let refusal: MdbaseSetupPlan["refusal"];
  if (status !== "current" && !input.canManage) refusal = { code: "setup_forbidden", message: "This app doesn't have permission to set up this collection." };
  else if (downgrade) refusal = { code: "setup_downgrade", message: "A newer version of this app set up this collection. Update the app to continue." };
  else if (conflicts.length) refusal = { code: "setup_conflict", message: conflicts.length === Object.keys(adoptable).length
    ? `${conflicts.length === 1 ? "One item differs" : `${conflicts.length} items differ`} from what this app needs. Choose whether to use this app's version to continue.`
    : "Some items can't be set up automatically. Resolve them, then try again." };
  else if (records.some(r => r.action === "create") && !input.canCreateRecords) refusal = { code: "setup_records_forbidden", message: "This app doesn't have permission to create notes in this collection." };
  const summary = status === "current" ? "Everything this app needs is already set up."
    : refusal ? refusal.message
      : `This app will make ${plural(changes.length, "change")} to this collection.`;
  return Object.freeze({
    status, canApply: status === "setup" && refusal === undefined, digest: assessed.assessmentDigest, summary,
    changes: Object.freeze(changes.map(c => Object.freeze(c))), conflicts: Object.freeze(conflicts.map(c => Object.freeze(c))),
    adoptable: Object.freeze(adoptable),
    packs: Object.freeze(review.packs.map(p => Object.freeze({ id: p.id, version: p.version, status: p.status, ...(p.installedVersion ? { installedVersion: p.installedVersion } : {}) }))),
    staged: review.staged, records: Object.freeze(records), ...(refusal ? { refusal: Object.freeze(refusal) } : {}),
  });
}
