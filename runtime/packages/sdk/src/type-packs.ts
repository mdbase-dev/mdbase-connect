/** Type packs: one reviewable plan, then one guarded all-or-nothing apply.
 * The replica's Core plans; the SDK never diffs, merges or writes on its own. */
import type { MdbaseClient, Write, WriteOptions } from "./client.js";
import { bool, hash, list, struct, tstr, uint, value } from "./codec.js";
import type { CborValue } from "./cbor.js";
import { isMdbaseError, MdbaseError, mdbaseError } from "./errors.js";
import { toPlain, toValue, type JsonLike, type PlainValue } from "./values.js";
import type { Op } from "./wire.js";

/** A pack: its manifest and the exact bytes of every manifest source. */
export interface TypePackProvision {
  /** The parsed manifest (JSON data); Core validates it. */
  manifest: object;
  resources: readonly { source: string; document: string }[];
  /** Accepted for compatibility; not used for planning. */
  provides?: unknown;
}

/** The caller's decisions. Pass the same options to `plan` and `apply`. */
export interface TypePackOptions {
  /** Stable reverse-domain installer identity, e.g. `app.example.notes`. */
  installedBy: string;
  /** Reviewed adoptions: target → its exact current digest (see `plan.adoptable`). */
  adopt?: Readonly<Record<string, string>>;
  /** Canonical target → collection target. */
  targetOverrides?: Readonly<Record<string, string>>;
  /** Seed targets intentionally left out. */
  preserveSeedTargets?: readonly string[];
  /** Permit installing an older version than the installed one. */
  allowDowngrade?: boolean;
  signal?: AbortSignal;
}

export type TypePackAction = "create" | "update" | "delete" | "adopt" | "unchanged" | "preserve" | "conflict";
export type TypePackResourceKind = "contract" | "type" | "schema";
export type TypePackStatus = "install" | "upgrade" | "downgrade" | "reconfigure" | "current" | "conflict";

/** One resource of the plan. `source` is empty for a retired resource with no lock entry. */
export interface TypePackResource {
  source: string;
  target: string;
  kind: TypePackResourceKind;
  mode: "managed" | "seed";
  action: TypePackAction;
  digest?: string;
  /** The live target's digest, when it exists. */
  currentDigest?: string;
  /** The digest the installed receipt records. */
  installedDigest?: string;
  /** The live digest an adoption took ownership of. */
  adoptedFromDigest?: string;
  /** Seed updates: the publisher baseline the update is based on. */
  upgradeBaseline?: { digest: string; version?: number };
  reason?: string;
}

export interface TypePackReceipt {
  id: string;
  version: string;
  digest: string;
  installedBy: string;
  resources: { source: string; target: string; kind: TypePackResourceKind; mode: "managed" | "seed"; digest: string; originDigest?: string }[];
}

/** Stable refusal codes; `message` is written to be shown as is. */
export type TypePackRefusalCode =
  | "forbidden"
  | "type_pack_conflict"
  | "type_pack_downgrade"
  | "invalid_type_pack"
  | "type_pack_contract_setups_unsupported";

export interface TypePackConflict {
  target: string;
  kind: TypePackResourceKind;
  reason?: string;
  message: string;
  /** Present when adopting the live target would resolve the conflict. */
  adoptable?: { digest: string };
}

/** One reviewable plan. Pass it to `typePacks.apply` unchanged. */
export interface TypePackPlan {
  readonly status: TypePackStatus;
  readonly canApply: boolean;
  /** Binds the pack, every relevant live target, the lock and the options. */
  readonly digest: string;
  /** Targets by action, for a diff. */
  readonly summary: Readonly<Record<TypePackAction, readonly string[]>>;
  readonly conflicts: readonly TypePackConflict[];
  /** Conflicts adoption would resolve: pass as `adopt` and plan again. */
  readonly adoptable: Readonly<Record<string, string>>;
  readonly resources: readonly TypePackResource[];
  readonly current?: TypePackReceipt;
  readonly desired: TypePackReceipt;
  readonly lock: { target: string; action: "create" | "update" | "unchanged"; digest: string };
  readonly refusal?: { code: TypePackRefusalCode; message: string };
  /** @internal */ readonly pack: TypePackProvision;
  /** @internal */ readonly options: TypePackOptions;
}

export interface TypePackApplyResult {
  /** `applied`: the mutation is confirmed. `pending`: accepted locally and
   * awaiting confirmation (`await write.confirmed`, which rejects with the
   * original mutation's problem if it is later rejected). `preview`: a
   * `dryRun`, nothing was installed. `already_current`: nothing to write. */
  outcome: "applied" | "pending" | "preview" | "already_current";
  receipt: TypePackReceipt;
  /** The one mutation (or dry run), when anything was written. */
  write?: Write;
}

interface PlanWire {
  version: number;
  assessment: CborValue;
  writes?: { path: string; doc?: string; baseRevision?: string; mustNotExist: boolean }[];
}
const writeWire = struct<NonNullable<PlanWire["writes"]>[number]>("type-pack-write-v1", [
  [0, "path", tstr], [1, "doc", tstr, "opt"], [2, "baseRevision", hash, "opt"], [3, "mustNotExist", bool],
]);
const planWire = struct<PlanWire>("type-pack-plan-v1", [
  [0, "version", uint], [1, "assessment", value], [2, "writes", list(writeWire), "opt"],
]);

const ACTIONS: readonly TypePackAction[] = ["create", "update", "delete", "adopt", "unchanged", "preserve", "conflict"];

type Obj = { [k: string]: JsonLike };
const obj = (v: JsonLike | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v: JsonLike | undefined): string | undefined => (typeof v === "string" ? v : undefined);
function opt<K extends string, V>(key: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [key]: v }) as { [P in K]?: V };
}

function receipt(v: JsonLike | undefined): TypePackReceipt {
  const r = obj(v);
  return {
    id: str(r.id)!, version: str(r.version)!, digest: str(r.digest)!, installedBy: str(r.installed_by)!,
    resources: (Array.isArray(r.resources) ? r.resources : []).map((x) => {
      const e = obj(x);
      return {
        source: str(e.source)!, target: str(e.target)!, kind: str(e.kind) as TypePackResourceKind,
        mode: str(e.mode) as "managed" | "seed", digest: str(e.digest)!, ...opt("originDigest", str(e.origin_digest)),
      };
    }),
  };
}

function resource(v: JsonLike): TypePackResource {
  const e = obj(v);
  const b = e.upgrade_baseline === undefined ? undefined : obj(e.upgrade_baseline);
  const version = b && (typeof b.version === "number" ? b.version : typeof b.version === "string" ? Number(b.version) : undefined);
  return {
    source: str(e.source) ?? "", target: str(e.target)!, kind: str(e.kind) as TypePackResourceKind,
    mode: str(e.mode) as "managed" | "seed", action: str(e.action) as TypePackAction,
    ...opt("digest", str(e.digest)), ...opt("currentDigest", str(e.current_digest)),
    ...opt("installedDigest", str(e.installed_digest)), ...opt("adoptedFromDigest", str(e.adopted_from_digest)),
    ...opt("upgradeBaseline", b && { digest: str(b.digest)!, ...opt("version", version) }),
    ...opt("reason", str(e.reason)),
  };
}

function conflictMessage(r: TypePackResource, adoptable: boolean): string {
  if (adoptable) return `${r.target} already exists with different content. Review it, then adopt it to let this pack manage it.`;
  return r.reason ? `${r.target} can't be changed: ${r.reason}.` : `${r.target} can't be changed by this pack.`;
}

/** The plan from the replica's assessment. */
function toPlan(raw: CborValue, pack: TypePackProvision, options: TypePackOptions): TypePackPlan {
  const a = obj(toPlain(raw));
  const resources = (Array.isArray(a.resources) ? a.resources : []).map(resource);
  const summary = Object.fromEntries(ACTIONS.map((k) => [k, resources.filter((r) => r.action === k).map((r) => r.target)])) as Record<TypePackAction, string[]>;
  const adoptable: Record<string, string> = {};
  const conflicts = resources.filter((r) => r.action === "conflict").map((r): TypePackConflict => {
    // An unmanaged live target the pack would own: adoption resolves it.
    const canAdopt = r.mode === "managed" && r.currentDigest !== undefined && r.installedDigest === undefined;
    if (canAdopt) adoptable[r.target] = r.currentDigest!;
    return {
      target: r.target, kind: r.kind, ...opt("reason", r.reason), message: conflictMessage(r, canAdopt),
      ...opt("adoptable", canAdopt ? { digest: r.currentDigest! } : undefined),
    };
  });
  const status = str(a.status) as TypePackStatus;
  const issues = Array.isArray(a.issues) ? a.issues.map(obj) : [];
  const desired = receipt(a.desired);
  let refusal: TypePackPlan["refusal"];
  if (a.definitions_manage !== true) {
    refusal = { code: "forbidden", message: "This app doesn't have permission to change the collection's types." };
  } else if (status === "downgrade") {
    const installed = a.current === undefined ? "a newer version" : `version ${receipt(a.current).version}`;
    refusal = { code: "type_pack_downgrade", message: `${desired.id} ${installed} is installed; ${desired.version} is older.` };
  } else if (conflicts.length) {
    const n = conflicts.length;
    refusal = {
      code: "type_pack_conflict",
      message: Object.keys(adoptable).length === n
        ? `${n === 1 ? "A type already exists" : `${n} types already exist`} with different content. Review and adopt ${n === 1 ? "it" : "them"} to continue.`
        : conflicts.map((c) => c.message).join(" "),
    };
  } else if (issues.length || a.applicable !== true) {
    refusal = { code: "invalid_type_pack", message: `This pack would leave the collection invalid: ${str(issues[0]?.message) ?? "the staged types do not validate"}.` };
  }
  const lock = obj(a.lock);
  return Object.freeze({
    status, canApply: a.applicable === true && refusal === undefined, digest: str(a.assessment_digest)!,
    summary, conflicts, adoptable, resources, ...opt("current", a.current === undefined ? undefined : receipt(a.current)),
    desired, lock: { target: str(lock.target)!, action: str(lock.action) as "create" | "update" | "unchanged", digest: str(lock.digest)! },
    ...opt("refusal", refusal), pack, options,
  });
}

function textMap(m: Readonly<Record<string, string>> | undefined): CborValue | undefined {
  return m && Object.keys(m).length ? toValue(m) : undefined;
}

function contractSetupsRequested(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (Array.isArray(input)) return input.length > 0;
  return typeof input === "object" && Object.keys(input).length > 0;
}

async function call(client: MdbaseClient, pack: TypePackProvision, o: TypePackOptions, expected?: string): Promise<PlanWire> {
  if (contractSetupsRequested((o as { contractSetups?: unknown }).contractSetups)) {
    throw mdbaseError("invalid_request", "Contract setup during type pack install is not supported yet.", "type_pack_contract_setups_unsupported");
  }
  const provision = new Map<string, CborValue>([
    ["manifest", toValue(pack.manifest as PlainValue)],
    ["resources", pack.resources.map((r) => new Map<string, CborValue>([["source", r.source], ["document", r.document]]))],
  ]);
  if (pack.provides !== undefined) provision.set("provides", toValue(pack.provides as PlainValue));
  const p = new Map<number, CborValue>([[0, 1], [1, provision], [2, o.installedBy]]);
  const adopt = textMap(o.adopt);
  if (adopt !== undefined) p.set(3, adopt);
  if (o.preserveSeedTargets?.length) p.set(4, [...o.preserveSeedTargets]);
  const overrides = textMap(o.targetOverrides);
  if (overrides !== undefined) p.set(5, overrides);
  if (o.allowDowngrade) p.set(6, true);
  if (expected !== undefined) p.set(7, hash.enc(expected));
  try {
    const r = await client.call("plan_type_pack_v1", p, { codec: planWire, retry: true, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.version !== 1) throw mdbaseError("upgrade_required", "unsupported type pack plan", "type_packs_unsupported");
    return r;
  } catch (e) {
    if (isMdbaseError(e, "invalid_request") && e.reason === "unknown_method") {
      throw mdbaseError("upgrade_required", "This collection's replica can't install type packs yet.", "type_packs_unsupported");
    }
    throw e;
  }
}

/** Plan a type pack against the local collection. Writes nothing. */
export async function planTypePack(client: MdbaseClient, pack: TypePackProvision, options: TypePackOptions): Promise<TypePackPlan> {
  return toPlan((await call(client, pack, options)).assessment, pack, options);
}

const REFUSAL_ERROR = {
  forbidden: "forbidden",
  type_pack_conflict: "conflict",
  type_pack_downgrade: "conflict",
  invalid_type_pack: "invalid_request",
  type_pack_contract_setups_unsupported: "invalid_request",
} as const;

/**
 * Apply a reviewed plan as one guarded mutation: every write, including the
 * lock and each adopted target, is bound to the revision the plan reviewed,
 * so the collection gets all of it or none. If anything changed since the
 * plan, this refuses with `conflict`/`concurrent_modification`; plan again.
 * An already-current pack writes nothing. A mutation the replica rejects or
 * cannot settle throws its problem with the original `mutationId`; it is
 * never reported as applied and never re-planned here.
 */
export async function applyTypePack(client: MdbaseClient, plan: TypePackPlan, o: WriteOptions = {}): Promise<TypePackApplyResult> {
  if (plan.refusal) throw mdbaseError(REFUSAL_ERROR[plan.refusal.code], plan.refusal.message, plan.refusal.code);
  const options = o.signal ? { ...plan.options, signal: o.signal } : plan.options;
  const r = await call(client, plan.pack, options, plan.digest);
  const applied = toPlan(r.assessment, plan.pack, plan.options);
  const writes = r.writes ?? [];
  if (!writes.length) return { outcome: "already_current", receipt: applied.desired };
  const ops = writes.map((w): Op => w.doc === undefined
    ? { kind: "resource_delete", path: w.path, ...opt("baseRevision", w.baseRevision) }
    : { kind: "resource_put", path: w.path, doc: w.doc, ...opt("baseRevision", w.baseRevision), ...(w.mustNotExist ? { mustNotExist: true } : {}) });
  const write = (await client.submit(ops, { ...o, allowPartial: false }))[0]!;
  const receipt = write.receipt;
  if (receipt.state === "rejected" || receipt.state === "unknown") {
    throw new MdbaseError(receipt.problem ?? (receipt.state === "unknown"
      ? { code: "outcome_unknown", recovery: "resolve_outcome", message: "The type pack install outcome is unknown." }
      : { code: "internal", recovery: "contact_support", message: "The type pack install was rejected." }), { mutationId: receipt.mutation });
  }
  // A dry run that would apply is a preview; nothing was installed.
  if (o.dryRun) return { outcome: "preview", receipt: applied.desired, write };
  if (receipt.status === "conflicted" || (receipt.conflicts?.length ?? 0) > 0) {
    throw new MdbaseError({ code: "conflict", recovery: "resolve_conflict", reason: "type_pack_conflict",
      message: "The type pack install has a conflict. Resolve it before continuing." }, { mutationId: receipt.mutation });
  }
  return { outcome: receipt.state === "confirmed" ? "applied" : "pending", receipt: applied.desired, write };
}
