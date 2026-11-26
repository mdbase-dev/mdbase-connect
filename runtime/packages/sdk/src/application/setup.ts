/** Reviewable collection setup: one plan for one review screen, then one
 * guarded all-or-nothing apply. Native Core plans; the SDK only words it. */
import type { AppResourceAssessment, AppResourceReview } from "../app-host/collection-control.js";
import type { MdbaseApplicationReadinessSnapshot, MdbaseApplicationRequestOptions } from "./entry.js";
import type { MdbaseSetupResult, MdbaseSnapshot } from "./front-door.js";
import { isMdbaseError } from "../errors.js";
import { versionRelation, type MdbaseVersionRelation } from "../semver.js";
import type { NewerPacks } from "./configuration.js";

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
/** Why setup can't run. `installed_newer`: a newer major version of this app's
 * types is installed; ask the person to update the app (describeError action
 * `update_app`). `setup_unresolved`: the collection still lacks what the app
 * needs and setup has nothing it may write to fix it (a note type it set up
 * was removed); the person changes the collection, then plans again.
 * `setup_downgrade` is the former name and is no longer produced. */
export type MdbaseSetupRefusalCode = "setup_forbidden" | "setup_conflict" | "setup_unresolved" | "installed_newer" | "setup_downgrade" | "setup_records_forbidden";
/** One type pack in a plan. `relation` compares the installed version with the
 * app's: `installed_newer` packs (same major) are kept as installed and the app
 * reads and writes them, keeping fields it does not know. */
export interface MdbaseSetupPack {
  readonly id: string;
  readonly version: string;
  readonly status: AppResourceReview["packs"][number]["status"];
  readonly installedVersion?: string;
  readonly relation?: MdbaseVersionRelation;
}
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
  readonly packs: readonly MdbaseSetupPack[];
  /** The definition documents setup would write, for a details view. */
  readonly staged: readonly { readonly path: string; readonly document: string }[];
  /** Starter records: `create` is written with the setup, `skip` already exists. */
  readonly records: readonly { readonly path: string; readonly action: "create" | "skip" }[];
  readonly refusal?: { readonly code: MdbaseSetupRefusalCode; readonly message: string };
}
/** SDK-8: how an apply ended. The collection changing since the review and an
 * unknown result are outcomes, with the snapshot as it is then; any other
 * failure rejects. */
export async function setupResult(applying: Promise<MdbaseSnapshot>, current: () => MdbaseSnapshot): Promise<MdbaseSetupResult> {
  try { return Object.freeze({ outcome: "applied" as const, snapshot: await applying }); } catch (error) {
    if (isMdbaseError(error, "conflict") && error.reason === "setup_changed") return Object.freeze({ outcome: "changed" as const, snapshot: current() });
    if (isMdbaseError(error, "outcome_unknown")) return Object.freeze({ outcome: "unknown" as const, snapshot: current() });
    throw error;
  }
}

const MAX_RECORDS = 32, MAX_RECORD_BYTES = 256 * 1024;
const name = (target: string) => (target.split("/").pop() ?? target).replace(/\.(md|ya?ml|json)$/i, "");
/** Explain the purpose, not an internal identifier. Exact paths and documents
 * remain in the plan for inspection; they are not names an owner chose. */
function definition(kind: string): { readonly key: string; readonly the: string; readonly bare: string; readonly many: string } {
  if (kind === "contract") return { key: "contract", the: "the shared format for this app's notes", bare: "shared format for this app's notes", many: "shared formats for this app's notes" };
  if (kind === "type") return { key: "type", the: "the note type for this app", bare: "note type for this app", many: "note types for this app" };
  if (kind === "schema") return { key: "schema", the: "the set of checks for this app's note properties", bare: "set of checks for this app's note properties", many: "sets of checks for this app's note properties" };
  return { key: "other", the: "the setup item this app needs", bare: "setup item this app needs", many: "setup items this app needs" };
}
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

const UNRESOLVED = "This collection is missing something this app needs, and setup can't add it. A note type this app set up may have been changed or removed. Restore it, then try again.";

/** A plan with nothing to write cannot open a collection whose required
 * contracts native readiness still finds missing or unimplemented (for example
 * the app's seeded type was deleted). Say so instead of "nothing to do". */
export function unresolvedSetup(plan: MdbaseSetupPlan, readiness: MdbaseApplicationReadinessSnapshot): MdbaseSetupPlan {
  if (plan.status !== "current" || plan.refusal || readiness.facets.contracts.assessment?.status !== "setup_required") return plan;
  return Object.freeze({ ...plan, status: "conflict" as const, summary: UNRESOLVED,
    refusal: Object.freeze({ code: "setup_unresolved" as const, message: UNRESOLVED }) });
}

/** Word native Core's review for a first-run user. No raw codes in messages. */
export function setupPlan(assessed: AppResourceAssessment, input: {
  readonly canManage: boolean; readonly canCreateRecords: boolean;
  readonly records: readonly { readonly path: string; readonly free: boolean }[];
  /** Packs installed at a newer version (see configuration `newerPacks`). */
  readonly newer?: NewerPacks;
  /** Existing files that Native setup will recognize as notes. */
  readonly promoted?: number;
}): MdbaseSetupPlan {
  const review = assessed.review!;
  let status = assessed.status === "current" ? "current" as const : assessed.status === "conflict" ? "conflict" as const : "setup" as const;
  const conflicts: MdbaseSetupConflict[] = [], adoptable: Record<string, string> = {};
  const replaced = new Set(review.staged.map(s => s.path));
  type Group = { readonly kind: MdbaseSetupChangeKind; readonly targets: string[]; count: number; readonly message: (count: number) => string };
  const groups = new Map<string, Group>();
  let totalChanges = 0, modifiesExisting = false;
  const addChange = (key: string, kind: MdbaseSetupChangeKind, target: string, message: (count: number) => string, modifies: boolean, count = 1) => {
    totalChanges += count;
    if (modifies) modifiesExisting = true;
    const existing = groups.get(key);
    if (existing) {
      existing.count += count;
      if (!existing.targets.includes(target)) existing.targets.push(target);
    } else {
      groups.set(key, { kind, targets: [target], count, message });
    }
  };
  for (const pack of review.packs) for (const r of pack.resources) {
    const thing = definition(r.kind), The = `T${thing.the.slice(1)}`;
    const why = r.kind === "contract" ? ", so other apps can work with them" : "";
    const noun = (n: number) => n === 1 ? thing.the : `${n} ${thing.many}`;
    switch (r.action) {
      case "create": addChange(`resource:create:${thing.key}`, "create", r.target, n => `Add ${noun(n)}${why}.`, false); break;
      case "update": addChange(`resource:update:${thing.key}`, "update", r.target, n => `Update ${noun(n)}.`, true); break;
      case "delete": addChange(`resource:delete:${thing.key}`, "delete", r.target, n => `Remove ${noun(n)}, which this app no longer uses.`, true); break;
      // Unreviewed, Core plans adopt only for byte-identical bytes: nothing is
      // written. A reviewed replacement is an adopt row whose document is staged.
      case "adopt":
        if (replaced.has(r.target)) {
          addChange(`resource:adopt-replace:${thing.key}`, "adopt", r.target, n => n === 1
            ? `Replace ${thing.the} with this app's version. Yours isn't kept.`
            : `Replace ${n} ${thing.many} with this app's versions. Yours aren't kept.`, true);
        } else {
          addChange(`resource:adopt-match:${thing.key}`, "adopt", r.target, n => n === 1
            ? `Use your existing ${thing.bare}, which already matches this app's.`
            : `Use your ${n} existing ${thing.many}, which already match this app's.`, false);
        }
        break;
      // Core keeps a seed that no published version upgrades (`reason` says
      // so); the app's version is then never written unless the person chooses
      // it, so a required contract could stay unimplemented while the pack
      // reads current. Like a conflicting seed, it is replaced only by choice.
      case "preserve":
      case "conflict": {
        if (r.action === "preserve" && r.reason === undefined) break;
        const seed = r.mode === "seed";
        const canAdopt = r.currentDigest !== undefined;
        if (canAdopt) adoptable[r.target] = r.currentDigest!;
        conflicts.push({ target: r.target, ...(canAdopt ? { adoptable: { digest: r.currentDigest! } } : {}),
          message: canAdopt && seed ? `Your ${thing.bare} has changes that can't be combined with the version this app needs. You can replace it with this app's version.`
            : canAdopt && r.installed ? `${The} was changed after this app set it up. You can replace it with this app's version.`
              : canAdopt ? `This collection already has a ${thing.bare} that differs from the one this app needs. You can replace it with this app's version.`
                : r.installed ? `${The} was changed after this app set it up, so it can't be updated automatically.`
                  : `${The} can't be set up automatically.` });
        break;
      }
      default: break;
    }
  }
  for (const c of review.configuration) {
    const label = setting(c.path);
    if (c.action === "add") {
      if (label === "include") {
        addChange("setting:include", "setting", label, () => "Include this app's files when reading the collection.", true);
      } else if (label === "record extensions" && typeof c.value === "string") {
        const ext = c.value.replace(/^\./, "");
        addChange(`setting:ext:${ext}`, "setting", label, () => `Read .${ext} files as notes in this collection.`, true);
      } else {
        addChange("setting:other", "setting", label, n => n === 1
          ? "Adjust a collection setting this app needs."
          : `Adjust ${n} collection settings this app needs.`, true);
      }
    } else conflicts.push({ target: label, message: "A collection setting differs from what this app needs, so it can't be changed automatically." });
  }
  const records = status === "current" ? [] : input.records.map(r => Object.freeze({ path: r.path, action: r.free ? "create" as const : "skip" as const }));
  for (const r of records) if (r.action === "create") {
    addChange(`record:${r.path}`, "record", r.path, () => `Create the starter note "${name(r.path)}".`, false);
  }
  if (input.promoted) {
    const promoted = input.promoted;
    addChange("record:existing-files", "record", "Existing files", () => `Recognize ${promoted} existing ${promoted === 1 ? "file" : "files"} as notes, preserving their contents.`, true, 1);
  }
  // Core's review omits its own receipt files (mdbase.provisions.yaml and the
  // type lock), yet a plan that only refreshes them still writes. Say so,
  // rather than promising that nothing changes.
  if (status === "setup" && groups.size === 0 && conflicts.length === 0)
    addChange("update:setup-record", "update", "Setup record", () => "Update this collection's record of this app's setup. Your notes and note types stay as they are.", true);
  const changes: MdbaseSetupChange[] = [...groups.values()].map(g => ({
    kind: g.kind, target: g.targets.join(", "), message: g.message(g.count),
  }));
  // A kept seed blocks even a pack Core reports current: never "nothing to do".
  if (status === "current" && conflicts.length) status = "conflict";
  const newerMajor = (input.newer?.major.length ?? 0) > 0 || review.packs.some(p => p.installedVersion && versionRelation(p.installedVersion, p.version) === "installed_newer_major");
  let refusal: MdbaseSetupPlan["refusal"];
  if (status !== "current" && !input.canManage) refusal = { code: "setup_forbidden", message: "This app doesn't have permission to set up this collection." };
  else if (newerMajor) refusal = { code: "installed_newer", message: "A newer version of this app set up this collection. Update the app to continue." };
  else if (conflicts.length) refusal = { code: "setup_conflict", message: conflicts.length === Object.keys(adoptable).length
    ? `${conflicts.length === 1 ? "One item differs" : `${conflicts.length} items differ`} from what this app needs. Choose whether to use this app's version to continue.`
    : "Some items can't be set up automatically. Resolve them, then try again." };
  else if (records.some(r => r.action === "create") && !input.canCreateRecords) refusal = { code: "setup_records_forbidden", message: "This app doesn't have permission to create notes in this collection." };
  const summary = status === "current" ? "Everything this app needs is already set up."
    : refusal ? refusal.message
      : `This app will make ${plural(totalChanges, "change")} to this collection.${
        !modifiesExisting ? " Nothing already in it is changed." : ""}`;
  return Object.freeze({
    status, canApply: status === "setup" && refusal === undefined, digest: assessed.assessmentDigest, summary,
    changes: Object.freeze(changes.map(c => Object.freeze(c))), conflicts: Object.freeze(conflicts.map(c => Object.freeze(c))),
    adoptable: Object.freeze(adoptable),
    packs: Object.freeze([
      ...review.packs.map(p => Object.freeze({ id: p.id, version: p.version, status: p.status,
        ...(p.installedVersion ? { installedVersion: p.installedVersion, relation: versionRelation(p.installedVersion, p.version) } : {}) })),
      ...(input.newer?.kept ?? []).map(p => Object.freeze({ id: p.id, version: p.version, status: "current" as const, installedVersion: p.installedVersion, relation: "installed_newer" as const })),
    ]),
    staged: review.staged, records: Object.freeze(records), ...(refusal ? { refusal: Object.freeze(refusal) } : {}),
  });
}
