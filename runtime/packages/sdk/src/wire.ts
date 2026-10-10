/**
 * Replica client API messages (`docs/contracts/replica-client-api.md`), typed.
 *
 * Mirrors `crates/wire/src/client.rs` and the operations of `crates/wire/src/intent.rs`.
 * Property names are the Rust field names in camelCase. Golden fixtures in
 * `conformance/wire/client/` and `conformance/wire/mutation/` check both sides agree.
 */
import type { CborValue } from "./cbor.js";
import { attachmentContentV1, type AttachmentContentV1 } from "./attachment-wire.js";
import {
  any,
  b16,
  b32,
  bool,
  bytes,
  Codec,
  dataMap,
  either,
  enumOf,
  Field,
  hash,
  int,
  list,
  mapped,
  SchemaError,
  struct,
  tstr,
  tuple,
  uint,
  union,
  uuid,
  value,
} from "./codec.js";

export type Uuid = string;
/** `sha256:<64 lowercase hex>`. */
export type Hash = string;
/** A frontmatter or app value; data maps are `Map`s (order is data). */
export type Value = CborValue;
export type FmMap = Map<string, Value>;

// ------------------------------------------------------------------ frames (§1)

export interface Version {
  major: number;
  minor: number;
}

export const version: Codec<Version> = mapped(
  "version",
  tuple<[number, number]>("version", [uint, uint]),
  ([major, minor]) => ({ major, minor }),
  (v): [number, number] => [v.major, v.minor],
);

export const RECOVERY = [
  "fix_request",
  "refresh",
  "resolve_conflict",
  "reauthorize",
  "repair_collection",
  "retry",
  "free_space",
  "upgrade",
  "resolve_outcome",
  "none",
  "contact_support",
] as const;
export type Recovery = (typeof RECOVERY)[number];
export const recovery = enumOf<Recovery>("recovery", RECOVERY);

export const severity = enumOf("severity", ["warning", "error"] as const);

export interface Issue {
  code: string;
  severity: "warning" | "error";
  message: string;
  details?: Value;
}

export const issue = struct<Issue>("issue", [
  [0, "code", tstr],
  [1, "severity", severity],
  [2, "message", tstr],
  [3, "details", value, "opt"],
]);

export interface Problem {
  code: string;
  recovery: Recovery;
  message: string;
  reason?: string;
  details?: Value;
  retryAfterMs?: number;
  issues?: Issue[];
  traceId?: string;
}

export const problem = struct<Problem>("problem", [
  [0, "code", tstr],
  [1, "recovery", recovery],
  [2, "message", tstr],
  [3, "reason", tstr, "opt"],
  [4, "details", value, "opt"],
  [5, "retryAfterMs", uint, "opt"],
  [6, "issues", list(issue), "opt"],
  [7, "traceId", tstr, "opt"],
]);

export type ClientFrame =
  | { kind: "request"; id: number; method: string; params: CborValue }
  | { kind: "response"; id: number; result?: CborValue; problem?: Problem }
  | { kind: "push"; type: string; payload: CborValue };

export const clientFrame = union<ClientFrame>("client-frame", [
  [
    0,
    "request",
    [
      [1, "id", uint],
      [2, "method", tstr],
      [3, "params", any],
    ],
  ],
  [
    1,
    "response",
    [
      [1, "id", uint],
      [2, "result", any, "opt"],
      [3, "problem", problem, "opt"],
    ],
  ],
  [
    2,
    "push",
    [
      [1, "type", tstr],
      [2, "payload", any],
    ],
  ],
]);

// ------------------------------------------------------------------ session (§2)

export interface HelloParams {
  versions: Version[];
  clientName: string;
  clientVersion: string;
  features?: string[];
  timezone?: string;
}

export const helloParams = struct<HelloParams>("hello-params", [
  [0, "versions", list(version, { nonEmpty: true }), "req1"],
  [1, "clientName", tstr],
  [2, "clientVersion", tstr],
  [3, "features", list(tstr), "opt"],
  [4, "timezone", tstr, "opt"],
]);

export const ROLES = ["viewer", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const role = enumOf<Role>("role", ROLES);

export interface GrantInfo {
  grant?: Uuid;
  capabilities: string[];
  role: Role;
  /** The account the session acts for (absent: local-only, or a service device). */
  account?: Uuid;
  /** The grant's folder scope of the file namespace (absent: unrestricted). */
  fileFolders?: string[];
}

export const grantInfo = struct<GrantInfo>("grant-info", [
  [0, "grant", uuid, "opt"],
  [1, "capabilities", list(tstr, { nonEmpty: true }), "req1"],
  [2, "role", role],
  [3, "account", uuid, "opt"],
  [4, "fileFolders", list(tstr), "opt"],
]);

export const INCIDENT_KINDS = [
  "upgrade_required",
  "waiting_for_key",
  "integrity",
  "access_revoked",
  "quota_exceeded",
  "read_only",
  "verification_mismatch",
  "voided_items",
  "key_inconsistent",
  "foreign_sync_tool",
  "gone",
  "lost_entries",
  "log_regressed",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export interface Incident {
  kind: IncidentKind;
  details?: Value;
}

export const incident = struct<Incident>("incident", [
  [0, "kind", enumOf<IncidentKind>("incident-kind", INCIDENT_KINDS)],
  [1, "details", value, "opt"],
]);

export interface Progress {
  done: number;
  total: number;
}

export const progress = struct<Progress>("progress", [
  [0, "done", uint],
  [1, "total", uint],
]);

/** Allocated lost-tail repair phases; progress metadata confers no authority. */
export type ResyncPhase = "probing" | "repairing" | "rolling_back" | "awaiting_control";

export interface Resyncing {
  phase: ResyncPhase;
  /** Positions still to restore (not ordinary pending mutations). */
  positions: number;
}

export const resyncing = struct<Resyncing>("resyncing", [
  [0, "phase", enumOf<ResyncPhase>("resync-phase", ["probing", "repairing", "rolling_back", "awaiting_control"])],
  [1, "positions", uint],
]);

export type SyncMode = "local_only" | "synced";
export type Connection = "online" | "connecting" | "offline";

/** Confirmed-only prefix facts. Decoding is neither authentication nor a readiness gate. */
export interface ConfirmedHead {
  seq: number;
  chain: Hash;
  policyGeneration: Hash;
  catalogGeneration: Hash;
}
export const confirmedHead = struct<ConfirmedHead>("confirmed-head", [
  [0, "seq", uint],
  [1, "chain", hash],
  [2, "policyGeneration", hash],
  [3, "catalogGeneration", hash],
]);

/** Historical position to compare under the existing authenticated READ session. */
export interface AppliedPrefixParams { seq: number }
export const appliedPrefixParams = struct<AppliedPrefixParams>("applied-prefix-params", [[0, "seq", uint]]);

/** Historical chain at the echoed seq, NOT the local current chain/generations. */
export interface AppliedPrefix {
  appliedThrough: number;
  seq: number;
  /** Absent for zero, behind, unretained or ineligible. Remain hosted. */
  chain?: Hash;
}
export const appliedPrefix = struct<AppliedPrefix>("applied-prefix", [
  [0, "appliedThrough", uint],
  [1, "seq", uint],
  [2, "chain", hash, "opt"],
]);

/** "Confirmed through N, plus pending" (§7). */
export interface SyncStatus {
  mode: SyncMode;
  confirmedThrough: number;
  headKnown: number;
  pending: number;
  oldestPending?: number;
  holds: number;
  unresolved: number;
  connection: Connection;
  installing?: Progress;
  incidents: Incident[];
  /** Present only while device-local lost-tail repair is active. */
  resyncing?: Resyncing;
  /** Optional confirmed-only fence. Absence is NOT permission to infer one. */
  confirmedHead?: ConfirmedHead;
}

export const syncStatus = struct<SyncStatus>("sync-status", [
  [0, "mode", enumOf<SyncMode>("sync-mode", ["local_only", "synced"])],
  [1, "confirmedThrough", uint],
  [2, "headKnown", uint],
  [3, "pending", uint],
  [4, "oldestPending", int, "opt"],
  [5, "holds", uint],
  [6, "unresolved", uint],
  [7, "connection", enumOf<Connection>("connection", ["online", "connecting", "offline"])],
  [8, "installing", progress, "opt"],
  [9, "incidents", list(incident)],
  [10, "resyncing", resyncing, "opt"],
  [11, "confirmedHead", confirmedHead, "opt"],
]);

export interface HelloResult {
  version: Version;
  runtimeVersion: string;
  sem: Version;
  collection: Uuid;
  grant: GrantInfo;
  status: SyncStatus;
  features: string[];
  /** The replica's latest signed head witness (log-entry.md §11), remote sessions. */
  headWitness?: Uint8Array;
}

export const helloResult = struct<HelloResult>("hello-result", [
  [0, "version", version],
  [1, "runtimeVersion", tstr],
  [2, "sem", version],
  [3, "collection", uuid],
  [4, "grant", grantInfo],
  [5, "status", syncStatus],
  [6, "features", list(tstr)],
  [7, "headWitness", bytes, "opt"],
]);

// ------------------------------------------------------------------ blobs, holds (§8)

export interface BlobRef {
  plainHash: Hash;
  size: number;
  blobId: Uint8Array;
  idEpoch: number;
  partSize: number;
}

export const blobRef = struct<BlobRef>("blob-ref", [
  [0, "plainHash", hash],
  [1, "size", uint],
  [2, "blobId", b32],
  [3, "idEpoch", uint],
  [4, "partSize", uint],
]);

/** Binary Hold content retains the COMPLETE typed manifest/content identity. */
export interface AttachmentHoldContent { form: "attachment"; content: AttachmentContentV1 }
/** Text/legacy BlobRef bytes are unchanged. Attachment is a closed critical arm,
 * used only by Holds, never a UTF8/text or snapshot-record fallback. */
export type TextOrBlob = string | BlobRef | AttachmentHoldContent;
export const textOrBlob: Codec<TextOrBlob> = {
  name: "text-or-blob",
  enc: v => {
    if (typeof v === "string") return tstr.enc(v);
    if ("form" in v) {
      if (v.form !== "attachment") throw new SchemaError("text-or-blob", "unknown arm", true);
      return [1, attachmentContentV1.enc(v.content)];
    }
    return blobRef.enc(v);
  },
  dec: c => {
    if (typeof c === "string") return tstr.dec(c);
    if (Array.isArray(c)) {
      if (c.length !== 2) throw new SchemaError("text-or-blob", "attachment arm must have exactly two elements");
      if (uint.dec(c[0]!) !== 1) throw new SchemaError("text-or-blob", "unknown attachment arm", true);
      return {form: "attachment", content: attachmentContentV1.dec(c[1]!)};
    }
    return blobRef.dec(c);
  },
};

export const HOLD_REASONS = [
  "conflict",
  "unknown_provenance",
  "deleted_elsewhere",
  "read_only",
  "editor_busy",
  "suspect_write",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
export const holdReason = enumOf<HoldReason>("hold-reason", HOLD_REASONS);

export interface HoldRef {
  id: Uuid;
  reason: HoldReason;
}

export const holdRef = struct<HoldRef>("hold-ref", [
  [0, "id", uuid],
  [1, "reason", holdReason],
]);

export interface Hold {
  id: Uuid;
  path: string;
  reason: HoldReason;
  since: number;
  base?: TextOrBlob;
  mine: TextOrBlob;
  theirs?: TextOrBlob;
  saves: number;
}

export const hold = struct<Hold>("hold", [
  [0, "id", uuid],
  [1, "path", tstr],
  [2, "reason", holdReason],
  [3, "since", int],
  [4, "base", textOrBlob, "opt"],
  [5, "mine", textOrBlob],
  [6, "theirs", textOrBlob, "opt"],
  [7, "saves", uint],
]);

export const HOLD_RESOLUTIONS = ["keep_mine", "take_theirs", "use", "delete", "keep_both"] as const;
export type HoldResolution = (typeof HOLD_RESOLUTIONS)[number];
export const holdResolution = enumOf<HoldResolution>("hold-resolution", HOLD_RESOLUTIONS);

// ------------------------------------------------------------------ records (§3)

export interface RecordState {
  state: "confirmed" | "pending";
  confirmedSeq: number;
  hold?: HoldRef;
  unresolved?: number;
}

export const recordState = struct<RecordState>("record-state", [
  [0, "state", enumOf("confirmation", ["confirmed", "pending"] as const)],
  [1, "confirmedSeq", uint],
  [2, "hold", holdRef, "opt"],
  [3, "unresolved", uint, "opt"],
]);

export type LinkTargetKind = "record" | "file" | "ambiguous" | "not_found" | "invalid";

export interface LinkResolution {
  kind: LinkTargetKind;
  target?: Uuid;
  path?: string;
}

export const linkResolution = struct<LinkResolution>("link-resolution", [
  [0, "kind", enumOf<LinkTargetKind>("link-kind", ["record", "file", "ambiguous", "not_found", "invalid"])],
  [1, "target", uuid, "opt"],
  [2, "path", tstr, "opt"],
]);

/** An outgoing link or embed, resolved at the local view (§3.1). */
export interface LinkView {
  raw: string;
  embed: boolean;
  resolution: LinkResolution;
  /** The frontmatter field holding it (absent: the body). */
  field?: string;
}

export const linkView = struct<LinkView>("link-view", [
  [0, "raw", tstr],
  [1, "embed", bool],
  [2, "resolution", linkResolution],
  [3, "field", tstr, "opt"],
]);

/**
 * Who wrote a change (§3.2). Show `account` as the author and `grant` as
 * "via <app>". `grantAccount` is present only when the hosted replica signed, and only
 * the hosted replica vouches for it.
 */
export interface AuthorRef {
  account: Uuid;
  device: Uuid;
  grant?: Uuid;
  grantAccount?: Uuid;
}

export const authorRef = struct<AuthorRef>("author-ref", [
  [0, "account", uuid],
  [1, "device", uuid],
  [2, "grant", uuid, "opt"],
  [3, "grantAccount", uuid, "opt"],
]);

export interface RecordView {
  id: Uuid;
  path: string;
  revision: Hash;
  frontmatter: FmMap;
  effective?: FmMap;
  body?: string;
  document?: string;
  types: string[];
  state: RecordState;
  diagnostics?: Issue[];
  /** `select` outputs by output name (queries with `select`). */
  values?: FmMap;
  /** Capture time of the last change to the bytes (§3.1); not a device file mtime. */
  mtime?: number;
  /** Outgoing links and embeds (include `links`). */
  links?: LinkView[];
  /** Who created the record (absent in local-only collections). */
  createdBy?: AuthorRef;
  /** Who last changed it. */
  modifiedBy?: AuthorRef;
}

export const fmMap = dataMap(value);

export const recordView = struct<RecordView>("record-view", [
  [0, "id", uuid],
  [1, "path", tstr],
  [2, "revision", hash],
  [3, "frontmatter", fmMap],
  [4, "effective", fmMap, "opt"],
  [5, "body", tstr, "opt"],
  [6, "document", tstr, "opt"],
  [7, "types", list(tstr)],
  [8, "state", recordState],
  [9, "diagnostics", list(issue), "opt"],
  [10, "values", fmMap, "opt"],
  [11, "mtime", int, "opt"],
  [12, "links", list(linkView), "opt"],
  [13, "createdBy", authorRef, "opt"],
  [14, "modifiedBy", authorRef, "opt"],
]);

export interface Include {
  effective?: boolean;
  body?: boolean;
  document?: boolean;
  diagnostics?: boolean;
  links?: boolean;
}

export const include = struct<Include>("include", [
  [0, "effective", bool, "opt"],
  [1, "body", bool, "opt"],
  [2, "document", bool, "opt"],
  [3, "diagnostics", bool, "opt"],
  [4, "links", bool, "opt"],
]);

// ------------------------------------------------------------------ reads (§4)

export interface ViewRef {
  path: string;
  view: string;
}

export const viewRef = struct<ViewRef>("view-ref", [
  [0, "path", tstr],
  [1, "view", tstr],
]);

/** Complete pre-window grouping tuple and native summary results. */
export interface QueryGroup {
  values: FmMap;
  count: number;
  summaries?: FmMap;
}
export const queryGroup = struct<QueryGroup>("query-group", [
  [0, "values", fmMap],
  [1, "count", uint],
  [2, "summaries", fmMap, "opt"],
]);

/** Full metadata replacement bound to the enclosing live update's asOf. */
export interface QueryMetadata {
  /** Selection order is this array's order, never FM-map iteration order. */
  columns?: string[];
  totalCount?: number;
  diagnostics?: Issue[];
  view?: ViewRef;
  groups?: QueryGroup[];
  hasMore?: boolean;
}
export const queryMetadata = struct<QueryMetadata>("query-metadata", [
  [0, "columns", list(tstr), "opt"],
  [1, "totalCount", uint, "opt"],
  [2, "diagnostics", list(issue), "opt"],
  [3, "view", viewRef, "opt"],
  [4, "groups", list(queryGroup), "opt"],
  [5, "hasMore", bool, "opt"],
]);

export interface QueryResult {
  records: RecordView[];
  cursor?: string;
  complete: boolean;
  asOf: number;
  /** `select` output names in selection order. */
  columns?: string[];
  /** Matches before pagination. */
  totalCount?: number;
  /** Per-record evaluation warnings. */
  diagnostics?: Issue[];
  /** The named view executed (`execute_view`). */
  view?: ViewRef;
  /** Complete native groups/summary results before pagination. */
  groups?: QueryGroup[];
  /** Flat matching records remain after the requested window. */
  hasMore?: boolean;
}

export const queryResult = struct<QueryResult>("query-result", [
  [0, "records", list(recordView)],
  [1, "cursor", tstr, "opt"],
  [2, "complete", bool],
  [3, "asOf", uint],
  [4, "columns", list(tstr), "opt"],
  [5, "totalCount", uint, "opt"],
  [6, "diagnostics", list(issue), "opt"],
  [7, "view", viewRef, "opt"],
  [8, "groups", list(queryGroup), "opt"],
  [9, "hasMore", bool, "opt"],
]);

export type UpdateKind = "snapshot" | "diff" | "reset";

export interface QueryUpdate {
  sub: number;
  kind: UpdateKind;
  added?: RecordView[];
  changed?: RecordView[];
  removed?: Uuid[];
  order?: Uuid[];
  complete: boolean;
  asOf: number;
  /** Full replacement, not a patch; absence does not mean zero/empty results. */
  metadata?: QueryMetadata;
}

export const queryUpdate = struct<QueryUpdate>("query-update", [
  [0, "sub", uint],
  [1, "kind", enumOf<UpdateKind>("update-kind", ["snapshot", "diff", "reset"])],
  [2, "added", list(recordView), "opt"],
  [3, "changed", list(recordView), "opt"],
  [4, "removed", list(uuid), "opt"],
  [5, "order", list(uuid), "opt"],
  [6, "complete", bool],
  [7, "asOf", uint],
  [8, "metadata", queryMetadata, "opt"],
]);

export interface Change {
  id: Uuid;
  path: string;
  kind: "put" | "remove";
  version: number;
  author?: AuthorRef;
}

export const change = struct<Change>("change", [
  [0, "id", uuid],
  [1, "path", tstr],
  [2, "kind", enumOf("change-kind", ["put", "remove"] as const)],
  [3, "version", uint],
  [4, "author", authorRef, "opt"],
]);

export interface ChangesResult {
  changes: Change[];
  cursor: string;
  reset: boolean;
}

export const changesResult = struct<ChangesResult>("changes-result", [
  [0, "changes", list(change)],
  [1, "cursor", tstr],
  [2, "reset", bool],
]);

// ------------------------------------------------------------------ operations (intent.md §3)

export const MEDIA_CLASSES = ["image", "audio", "video", "pdf", "other"] as const;
export type MediaClass = (typeof MEDIA_CLASSES)[number];
export const mediaClass = enumOf<MediaClass>("media-class", MEDIA_CLASSES);

export type ConflictMode = "record" | "reject";
export const conflictMode = enumOf<ConflictMode>("conflict-mode", ["record", "reject"]);

/** `[key]` (the key was missing) or `[key, observed]`. */
export interface BaseField {
  key: string;
  observed?: Value;
}

export const baseField: Codec<BaseField> = {
  name: "base-field",
  enc: (v) => (v.observed === undefined ? [v.key] : [v.key, value.enc(v.observed)]),
  dec: (c) => {
    if (!Array.isArray(c) || c.length < 1 || c.length > 2) {
      throw new SchemaError("base-field", "must have 1 or 2 elements");
    }
    return c.length === 1 ? { key: tstr.dec(c[0]!) } : { key: tstr.dec(c[0]!), observed: value.dec(c[1]!) };
  },
};

/** `[start, end, insert]`, offsets in Unicode scalar values of the base body. */
export type BodyEdit = [start: number, end: number, insert: string];
export const bodyEdit = tuple<BodyEdit>("body-edit", [uint, uint, tstr]);

export interface DocVersion {
  path: string;
  doc: string;
}

export const docVersion = struct<DocVersion>("doc-version", [
  [0, "path", tstr],
  [1, "doc", tstr],
]);

export interface FileInclusion {
  include: MediaClass[];
  exclude?: string[];
  maxSize?: number;
}

export const fileInclusion = struct<FileInclusion>("file-inclusion", [
  [0, "include", list(mediaClass)],
  [1, "exclude", list(tstr), "opt"],
  [2, "maxSize", uint, "opt"],
]);

export type Op =
  | { kind: "create"; id: Uuid; path?: string; type?: string; frontmatter?: FmMap; body?: string; document?: string }
  | {
      kind: "update";
      id: Uuid;
      patch?: FmMap;
      unset?: string[];
      add?: Map<string, Value[]>;
      remove?: Map<string, Value[]>;
      body?: string;
      bodyEdits?: BodyEdit[];
      bodyBase?: Hash;
      bodyBaseText?: string;
      base?: BaseField[];
      ifRevision?: Hash;
    }
  | { kind: "document"; id: Uuid; base?: DocVersion; new?: DocVersion; ifRevision?: Hash }
  | { kind: "delete"; id: Uuid; baseRevision?: Hash; ifRevision?: Hash }
  | { kind: "rename"; id: Uuid; from: string; to: string; updateRefs: boolean; ifRevision?: Hash }
  | { kind: "resource_put"; path: string; doc: string; baseRevision?: Hash; mustNotExist?: boolean }
  | { kind: "resource_delete"; path: string; baseRevision?: Hash }
  | { kind: "file_put"; id: Uuid; path: string; blob: BlobRef; ifRevision?: Hash; base?: Hash }
  | { kind: "file_delete"; id: Uuid; ifRevision?: Hash; base?: Hash }
  | { kind: "file_move"; id: Uuid; from: string; to: string; updateRefs: boolean; ifRevision?: Hash }
  | { kind: "conflict_dismiss"; mutation: Uuid; record: Uuid }
  | { kind: "sync_settings"; inclusion: FileInclusion };

const listsByField = dataMap(list(value));

export const op = union<Op>("op", [
  [
    1,
    "create",
    [
      [1, "id", uuid],
      [2, "path", tstr, "opt"],
      [3, "type", tstr, "opt"],
      [4, "frontmatter", fmMap, "opt"],
      [5, "body", tstr, "opt"],
      [6, "document", tstr, "opt"],
    ],
  ],
  [
    2,
    "update",
    [
      [1, "id", uuid],
      [2, "patch", fmMap, "opt"],
      [3, "unset", list(tstr), "opt1"],
      [4, "add", listsByField, "opt"],
      [5, "remove", listsByField, "opt"],
      [6, "body", tstr, "opt"],
      [7, "bodyEdits", list(bodyEdit), "opt1"],
      [8, "bodyBase", hash, "opt"],
      [9, "bodyBaseText", tstr, "opt"],
      [10, "base", list(baseField), "opt1"],
      [11, "ifRevision", hash, "opt"],
    ],
  ],
  [
    3,
    "document",
    [
      [1, "id", uuid],
      [2, "base", docVersion, "opt"],
      [3, "new", docVersion, "opt"],
      [4, "ifRevision", hash, "opt"],
    ],
  ],
  [
    4,
    "delete",
    [
      [1, "id", uuid],
      [2, "baseRevision", hash, "opt"],
      [3, "ifRevision", hash, "opt"],
    ],
  ],
  [
    5,
    "rename",
    [
      [1, "id", uuid],
      [2, "from", tstr],
      [3, "to", tstr],
      [4, "updateRefs", bool],
      [5, "ifRevision", hash, "opt"],
    ],
  ],
  [
    6,
    "resource_put",
    [
      [1, "path", tstr],
      [2, "doc", tstr],
      [3, "baseRevision", hash, "opt"],
      // The path must hold no resource (S-class; conflict/path_taken otherwise).
      [4, "mustNotExist", bool, "opt"],
    ],
  ],
  [
    7,
    "resource_delete",
    [
      [1, "path", tstr],
      [2, "baseRevision", hash, "opt"],
    ],
  ],
  [
    8,
    "file_put",
    [
      [1, "id", uuid],
      [2, "path", tstr],
      [3, "blob", blobRef],
      [4, "ifRevision", hash, "opt"],
      [5, "base", hash, "opt"],
    ],
  ],
  [
    9,
    "file_delete",
    [
      [1, "id", uuid],
      [2, "ifRevision", hash, "opt"],
      [3, "base", hash, "opt"],
    ],
  ],
  [
    10,
    "file_move",
    [
      [1, "id", uuid],
      [2, "from", tstr],
      [3, "to", tstr],
      [4, "updateRefs", bool],
      [5, "ifRevision", hash, "opt"],
    ],
  ],
  [
    11,
    "conflict_dismiss",
    [
      [1, "mutation", uuid],
      [2, "record", uuid],
    ],
  ],
  [12, "sync_settings", [[1, "inclusion", fileInclusion]]],
]);

// ------------------------------------------------------------------ writes (§5, §6)

export interface SubmitParams {
  ops: Op[];
  mutationId?: Uuid;
  conflictMode?: ConflictMode;
  timezone?: string;
  allowPartial?: boolean;
  mutationIds?: Uuid[];
  dryRun?: boolean;
  include?: Include;
  wait?: "pending" | "confirmed" | "published";
}

export const submitParams = struct<SubmitParams>("submit-params", [
  [0, "ops", list(op, { nonEmpty: true }), "req1"],
  [1, "mutationId", uuid, "opt"],
  [2, "conflictMode", conflictMode, "opt"],
  [3, "timezone", tstr, "opt"],
  [4, "allowPartial", bool, "opt"],
  [5, "mutationIds", list(uuid), "opt1"],
  [6, "dryRun", bool, "opt"],
  [7, "include", include, "opt"],
  [8, "wait", enumOf("wait-for", ["pending", "confirmed", "published"] as const), "opt"],
]);

export type ConflictValue =
  | { form: "missing" }
  | { form: "value"; value: Value }
  | { form: "text"; text: string }
  | { form: "blob"; blob: BlobRef }
  | { form: "deleted" };

const CONFLICT_FORMS = ["missing", "value", "text", "blob", "deleted"] as const;

export const conflictValue: Codec<ConflictValue> = {
  name: "conflict-value",
  enc: (v) => {
    switch (v.form) {
      case "missing":
        return [0];
      case "value":
        return [1, value.enc(v.value)];
      case "text":
        return [2, v.text];
      case "blob":
        return [3, blobRef.enc(v.blob)];
      case "deleted":
        return [4];
    }
  },
  dec: (c) => {
    if (!Array.isArray(c) || c.length === 0) throw new SchemaError("conflict-value", "malformed conflict value");
    const t = c[0];
    if (typeof t !== "number") throw new SchemaError("conflict-value", "malformed conflict value");
    if (t > 4) throw new SchemaError("conflict-value", `unknown variant ${t}`, true);
    const form = CONFLICT_FORMS[t]!;
    if (form === "missing" || form === "deleted") {
      if (c.length !== 1) throw new SchemaError("conflict-value", "malformed conflict value");
      return { form };
    }
    if (c.length !== 2) throw new SchemaError("conflict-value", "malformed conflict value");
    if (form === "value") return { form, value: value.dec(c[1]!) };
    if (form === "text") {
      // Inside a log entry a text may be a text-table index; clients only see strings.
      return { form, text: tstr.dec(c[1]!) };
    }
    return { form, blob: blobRef.dec(c[1]!) };
  },
};

export type ConflictKind = "field" | "frontmatter" | "body" | "path" | "delete" | "file";

export interface Conflict {
  kind: ConflictKind;
  id: Uuid;
  field?: string;
  base?: ConflictValue;
  kept: ConflictValue;
  lost: ConflictValue;
}

export const conflict = struct<Conflict>("conflict", [
  [
    0,
    "kind",
    // Wire values start at 1.
    enumOf<ConflictKind>("conflict-kind", ["field", "frontmatter", "body", "path", "delete", "file"], 1),
  ],
  [1, "id", uuid],
  [2, "field", tstr, "opt"],
  [3, "base", conflictValue, "opt"],
  [4, "kept", conflictValue],
  [5, "lost", conflictValue],
]);

export type ReceiptState = "pending" | "confirmed" | "rejected" | "unknown";
export type EntryStatus = "applied" | "merged" | "conflicted";
/** Local file publication, independent of log confirmation. */
export type PublishState = "publishing" | "published" | "not_published";
export const publishState = enumOf<PublishState>("publish-state", ["publishing", "published", "not_published"]);

export interface LinkRewrite {
  record: Uuid;
  path: string;
  from: string;
  to: string;
  field?: string;
}

export interface BrokenLink {
  record: Uuid;
  path: string;
  raw: string;
  target: Uuid;
  field?: string;
}

/** What a rename or delete dialog shows (dry run only, §5). */
export interface Preflight {
  rewrites: LinkRewrite[];
  broken: BrokenLink[];
}

export const preflight = struct<Preflight>("preflight", [
  [
    0,
    "rewrites",
    list(
      struct<LinkRewrite>("link-rewrite", [
        [0, "record", uuid],
        [1, "path", tstr],
        [2, "from", tstr],
        [3, "to", tstr],
        [4, "field", tstr, "opt"],
      ]),
    ),
  ],
  [
    1,
    "broken",
    list(
      struct<BrokenLink>("broken-link", [
        [0, "record", uuid],
        [1, "path", tstr],
        [2, "raw", tstr],
        [3, "target", uuid],
        [4, "field", tstr, "opt"],
      ]),
    ),
  ],
]);

export interface Receipt {
  mutation: Uuid;
  state: ReceiptState;
  seq?: number;
  status?: EntryStatus;
  conflicts?: Conflict[];
  records?: RecordView[];
  problem?: Problem;
  /** Present on file-backed replicas; not a confirmation/custody authority. */
  published?: PublishState;
  /** Dry run only. */
  preflight?: Preflight;
  /** Earlier confirmed position after acknowledged-intent resurrection. */
  relocatedFrom?: number;
}

export const receipt = struct<Receipt>("receipt", [
  [0, "mutation", uuid],
  [1, "state", enumOf<ReceiptState>("receipt-state", ["pending", "confirmed", "rejected", "unknown"])],
  [2, "seq", uint, "opt"],
  [3, "status", enumOf<EntryStatus>("status", ["applied", "merged", "conflicted"]), "opt"],
  [4, "conflicts", list(conflict), "opt1"],
  [5, "records", list(recordView), "opt"],
  [6, "problem", problem, "opt"],
  [7, "published", publishState, "opt"],
  [8, "preflight", preflight, "opt"],
  [9, "relocatedFrom", uint, "opt"],
]);

export const submitResult = list(receipt, { nonEmpty: true });

export interface ConflictEntry {
  mutation: Uuid;
  seq: number;
  conflict: Conflict;
}

export const conflictEntry = struct<ConflictEntry>("conflict-entry", [
  [0, "mutation", uuid],
  [1, "seq", uint],
  [2, "conflict", conflict],
]);

// ------------------------------------------------------------------ files (§10)

export type FileState = "materialized" | "remote" | "fetching" | "pending_upload";

export interface FileView {
  id: Uuid;
  path: string;
  size: number;
  digest: Hash;
  media: MediaClass;
  state: FileState;
  confirmedSeq: number;
  hold?: HoldRef;
  /** Capture time of the last change to the content (§3.1). */
  mtime?: number;
}

export const fileView = struct<FileView>("file-view", [
  [0, "id", uuid],
  [1, "path", tstr],
  [2, "size", uint],
  [3, "digest", hash],
  [4, "media", mediaClass],
  [5, "state", enumOf<FileState>("file-state", ["materialized", "remote", "fetching", "pending_upload"])],
  [6, "confirmedSeq", uint],
  [7, "hold", holdRef, "opt"],
  [8, "mtime", int, "opt"],
]);

export interface ListFilesResult {
  files: FileView[];
  cursor?: string;
  complete: boolean;
}

export const listFilesResult = struct<ListFilesResult>("list-files-result", [
  [0, "files", list(fileView)],
  [1, "cursor", tstr, "opt"],
  [2, "complete", bool],
]);

export interface OpenUploadParams {
  transfer: Uuid;
  path: string;
  size: number;
  digest?: Hash;
  fileId?: Uuid;
  ifRevision?: Hash;
  mutationId?: Uuid;
}

export const openUploadParams = struct<OpenUploadParams>("open-upload-params", [
  [0, "transfer", uuid],
  [1, "path", tstr],
  [2, "size", uint],
  [3, "digest", hash, "opt"],
  [4, "fileId", uuid, "opt"],
  [5, "ifRevision", hash, "opt"],
  [6, "mutationId", uuid, "opt"],
]);

export interface OpenUploadResult {
  transfer: Uuid;
  chunkSize: number;
  received: number[];
  expiresAt: number;
}

export const openUploadResult = struct<OpenUploadResult>("open-upload-result", [
  [0, "transfer", uuid],
  [1, "chunkSize", uint],
  [2, "received", list(uint)],
  [3, "expiresAt", int],
]);

export interface UploadChunkParams {
  transfer: Uuid;
  index: number;
  bytes: Uint8Array;
}

export const uploadChunkParams = struct<UploadChunkParams>("upload-chunk-params", [
  [0, "transfer", uuid],
  [1, "index", uint],
  [2, "bytes", { name: "bstr", enc: (v: Uint8Array) => v, dec: (c) => (c instanceof Uint8Array ? c : bad("bstr")) }],
]);

function bad(ty: string): never {
  throw new SchemaError(ty, "wrong type");
}

export interface FileChunk {
  stream: number;
  offset: number;
  bytes: Uint8Array;
  last: boolean;
}

export const fileChunk = struct<FileChunk>("file-chunk", [
  [0, "stream", uint],
  [1, "offset", uint],
  [2, "bytes", { name: "bstr", enc: (v: Uint8Array) => v, dec: (c) => (c instanceof Uint8Array ? c : bad("bstr")) }],
  [3, "last", bool],
]);

export const TRANSFER_PHASES = [
  "receiving",
  "sealing",
  "uploading",
  "appending",
  "confirmed",
  "fetching",
  "streaming",
  "done",
] as const;
export type TransferPhase = (typeof TRANSFER_PHASES)[number];

/** Upload transfers are identified by UUID, download streams by number. */
export interface TransferProgress {
  id: Uuid | number;
  phase: TransferPhase;
  done: number;
  total: number;
}

export const transferProgress = struct<TransferProgress>("transfer-progress", [
  [
    0,
    "id",
    either<string, number>(
      "transfer-id",
      uuid,
      (v): v is string => typeof v === "string",
      (c) => c instanceof Uint8Array,
      uint,
    ),
  ],
  [1, "phase", enumOf<TransferPhase>("phase", TRANSFER_PHASES)],
  [2, "done", uint],
  [3, "total", uint],
]);

export interface Materialization {
  mode: "all" | "on_demand";
  pinned?: string[];
  media?: MediaClass[];
  maxSize?: number;
}

export const materialization = struct<Materialization>("materialization", [
  [0, "mode", enumOf("materialize-mode", ["all", "on_demand"] as const)],
  [1, "pinned", list(tstr), "opt"],
  [2, "media", list(mediaClass), "opt"],
  [3, "maxSize", uint, "opt"],
]);

// ------------------------------------------------------------------ presence (§11)

export interface Peer {
  /** Opaque per-session pseudonym (16 bytes). */
  session: Uint8Array;
  account?: Uuid;
  app?: string;
  state: Value;
  lastSeen: number;
}

export const peer = struct<Peer>("peer", [
  [0, "session", b16],
  [1, "account", uuid, "opt"],
  [2, "app", tstr, "opt"],
  [3, "state", value],
  [4, "lastSeen", int],
]);

export interface PresencePush {
  record: Uuid;
  peers: Peer[];
}

export const presencePush = struct<PresencePush>("presence", [
  [0, "record", uuid],
  [1, "peers", list(peer)],
]);

// ------------------------------------------------------------------ editor fence (§14)

export interface FenceApply {
  path: string;
  base: Hash;
  edits: BodyEdit[];
  expected: Hash;
}

export const fenceApply = struct<FenceApply>("fence-apply", [
  [0, "path", tstr],
  [1, "base", hash],
  [2, "edits", list(bodyEdit, { nonEmpty: true }), "req1"],
  [3, "expected", hash],
]);

export interface FenceReportEntry {
  path: string;
  dirty: boolean;
  buffer: Hash;
}

export const fenceReport = struct<{ open: FenceReportEntry[] }>("fence-report", [
  [
    0,
    "open",
    list(
      struct<FenceReportEntry>("fence-open", [
        [0, "path", tstr],
        [1, "dirty", bool],
        [2, "buffer", hash],
      ]),
    ),
  ],
]);

export const fenceResult = struct<{ outcome: "applied" | "not_open" | "buffer_changed"; buffer?: string }>(
  "fence-result",
  [
    [0, "outcome", enumOf("fence-outcome", ["applied", "not_open", "buffer_changed"] as const)],
    [1, "buffer", tstr, "opt"],
  ],
);

/** Codecs for the push types of the API, keyed by push type. */
export const PUSH_CODECS: Record<string, Codec<any>> = {
  query_update: queryUpdate,
  receipt,
  status: syncStatus,
  holds: list(hold),
  conflicts: list(conflictEntry),
  presence: presencePush,
  file_chunk: fileChunk,
  transfer_progress: transferProgress,
  changes: changesResult,
};

export { b16, b32 };

// ------------------------------------------------------------------ mutation (intent.md §1)

export interface OpClock {
  instant: number;
  tz: string;
  localDate: string;
}
export const opClock = struct<OpClock>("op-clock", [
  [0, "instant", int], [1, "tz", tstr], [2, "localDate", tstr],
]);

export interface Mutation {
  id: Uuid;
  origin: Uuid;
  baseSeq: number;
  clock: OpClock;
  seed: Uint8Array;
  source: "api" | "external";
  ops: Op[];
  onBehalf?: Uuid;
  conflictMode?: ConflictMode;
  validatedAt?: "off" | "warn" | "error";
  room?: { stream: Uint8Array; state: Hash };
}

/**
 * A captured mutation. Clients never build these (the replica captures them); the
 * codec exists so the SDK runs the `conformance/wire/mutation/` fixtures.
 */
export const mutation = struct<Mutation>("mutation", [
  [0, "id", uuid],
  [1, "origin", uuid],
  [2, "baseSeq", uint],
  [
    3,
    "clock",
    opClock,
  ],
  [4, "seed", b32],
  [5, "source", enumOf("source", ["api", "external"] as const)],
  [6, "ops", list(op, { nonEmpty: true }), "req1"],
  [7, "onBehalf", uuid, "opt"],
  [8, "conflictMode", conflictMode, "opt"],
  [9, "validatedAt", enumOf("level", ["off", "warn", "error"] as const), "opt"],
  [
    10,
    "room",
    struct<{ stream: Uint8Array; state: Hash }>("room-checkpoint", [
      [0, "stream", b16],
      [1, "state", hash],
    ]),
    "opt",
  ],
]);

// ------------------------------------------------------------------ definitions, views, links, pending

const confirmation = enumOf("confirmation", ["confirmed", "pending"] as const);

/** A resource: `mdbase.yaml`, a type file or a contract file (§4.1). */
export interface ResourceView {
  path: string;
  /** Pass as `baseRevision` to `resource_put` / `resource_delete` for CAS. */
  revision: Hash;
  size: number;
  state: "confirmed" | "pending";
  text?: string;
}

export const resourceView = struct<ResourceView>("resource-view", [
  [0, "path", tstr],
  [1, "revision", hash],
  [2, "size", uint],
  [3, "state", confirmation],
  [4, "text", tstr, "opt"],
]);

/** One inventory page. A continuation is opaque and bound to its original read.
 * Only a terminal page has complete=true; callers needing a snapshot must retain
 * every page and refuse cursor errors rather than silently restart. */
export interface ListResourcesResult {
  resources: ResourceView[];
  complete: boolean;
  cursor?: string;
}

export const listResourcesResult = struct<ListResourcesResult>("list-resources-result", [
  [0, "resources", list(resourceView)],
  [1, "complete", bool],
  [2, "cursor", tstr, "opt"],
]);

export interface Backlink {
  record: RecordView;
  links: LinkView[];
}

export interface BacklinksResult {
  backlinks: Backlink[];
  cursor?: string;
  complete: boolean;
  asOf: number;
}

export const backlinksResult = struct<BacklinksResult>("backlinks-result", [
  [
    0,
    "backlinks",
    list(
      struct<Backlink>("backlink", [
        [0, "record", recordView],
        [1, "links", list(linkView, { nonEmpty: true }), "req1"],
      ]),
    ),
  ],
  [1, "cursor", tstr, "opt"],
  [2, "complete", bool],
  [3, "asOf", uint],
]);

export interface ViewProperty {
  key: string;
  label?: string;
  description?: string;
  format?: string;
  hidden?: boolean;
}

export interface ViewDescriptor {
  id: string;
  name: string;
  properties: ViewProperty[];
  presentation?: Value;
}

export interface ViewSource {
  record: Uuid;
  id: string;
  name: string;
  source: { path: string; format: string; revision: Hash; writable: boolean };
  views: ViewDescriptor[];
}

export const listViewsResult = struct<{ sources: ViewSource[]; diagnostics: Issue[]; complete: boolean }>(
  "list-views-result",
  [
    [
      0,
      "sources",
      list(
        struct<ViewSource>("view-source", [
          [0, "record", uuid],
          [1, "id", tstr],
          [2, "name", tstr],
          [
            3,
            "source",
            struct<ViewSource["source"]>("view-source-ref", [
              [0, "path", tstr],
              [1, "format", tstr],
              [2, "revision", hash],
              [3, "writable", bool],
            ]),
          ],
          [
            4,
            "views",
            list(
              struct<ViewDescriptor>("view-descriptor", [
                [0, "id", tstr],
                [1, "name", tstr],
                [
                  2,
                  "properties",
                  list(
                    struct<ViewProperty>("view-property", [
                      [0, "key", tstr],
                      [1, "label", tstr, "opt"],
                      [2, "description", tstr, "opt"],
                      [3, "format", tstr, "opt"],
                      [4, "hidden", bool, "opt"],
                    ]),
                  ),
                ],
                [3, "presentation", value, "opt"],
              ]),
            ),
          ],
        ]),
      ),
    ],
    [1, "diagnostics", list(issue)],
    [2, "complete", bool],
  ],
);

export interface ViewSourceDocument {
  path: string;
  format: string;
  revision: Hash;
  document: string;
  record: Uuid;
}

export const viewSourceDocument = struct<ViewSourceDocument>("view-source-document", [
  [0, "path", tstr],
  [1, "format", tstr],
  [2, "revision", hash],
  [3, "document", tstr],
  [4, "record", uuid],
]);

export interface ContractImplementation {
  contract: string;
  version: string;
  /** Contract field reference → record field reference. */
  fields: Map<string, string>;
  binding?: Value;
}

export interface TypeSummary {
  name: string;
  path: string;
  implements: ContractImplementation[];
}

export interface ContractSummary {
  id: string;
  version: string;
  path: string;
  digest: Hash;
  contractType: string;
  implementedBy: string[];
}

export interface DescribeResult {
  specVersion: string;
  types: TypeSummary[];
  settings: Value;
  inclusion: FileInclusion;
  issues: Issue[];
  contracts: ContractSummary[];
}

export const describeResult = struct<DescribeResult>("describe-result", [
  [0, "specVersion", tstr],
  [
    1,
    "types",
    list(
      struct<TypeSummary>("type-summary", [
        [0, "name", tstr],
        [1, "path", tstr],
        [
          2,
          "implements",
          list(
            struct<ContractImplementation>("implementation", [
              [0, "contract", tstr],
              [1, "version", tstr],
              [2, "fields", dataMap(tstr)],
              [3, "binding", value, "opt"],
            ]),
          ),
        ],
      ]),
    ),
  ],
  [2, "settings", value],
  [3, "inclusion", fileInclusion],
  [4, "issues", list(issue)],
  [
    5,
    "contracts",
    list(
      struct<ContractSummary>("contract-summary", [
        [0, "id", tstr],
        [1, "version", tstr],
        [2, "path", tstr],
        [3, "digest", hash],
        [4, "contractType", tstr],
        [5, "implementedBy", list(tstr)],
      ]),
    ),
  ],
]);

export interface PendingMutation {
  receipt: Receipt;
  captured: number;
  ops: Op[];
}

export const listPendingResult = struct<{ pending: PendingMutation[]; next?: Uuid }>("list-pending-result", [
  [
    0,
    "pending",
    list(
      struct<PendingMutation>("pending-mutation", [
        [0, "receipt", receipt],
        [1, "captured", int],
        [2, "ops", list(op, { nonEmpty: true }), "req1"],
      ]),
    ),
  ],
  [1, "next", uuid, "opt"],
]);

/** A record or file by ID (uuid bytes) or path (text). */
export const target: Codec<Uuid | { path: string }> = {
  name: "target",
  enc: (v) => (typeof v === "string" ? uuid.enc(v) : v.path),
  dec: (c) => (typeof c === "string" ? { path: c } : uuid.dec(c)),
};

export interface QueryParams {
  query: Value;
  include?: Include;
  contract?: string;
}

export const queryParams = struct<QueryParams>("query-params", [
  [0, "query", value],
  [1, "include", include, "opt"],
  [2, "contract", tstr, "opt"],
]);

export interface ExecuteViewParams {
  source: Uuid | { path: string };
  view: string;
  context?: Uuid | { path: string };
  limit?: number;
  offset?: number;
  timezone?: string;
  include?: Include;
}

export const executeViewParams = struct<ExecuteViewParams>("execute-view-params", [
  [0, "source", target],
  [1, "view", tstr],
  [2, "context", target, "opt"],
  [3, "limit", uint, "opt"],
  [4, "offset", uint, "opt"],
  [5, "timezone", tstr, "opt"],
  [6, "include", include, "opt"],
]);

// ------------------------------------------------------------------ describe_typing

/**
 * Core's `temporal_hint`: `date` / `date_time` only when every requested type declares
 * the same `format` at that top-level field; any unknown type, nested path or
 * disagreement is `none`. Plain strings stay text even if they look like dates.
 */
export const TEMPORAL_HINTS = ["none", "date", "date_time"] as const;
export type TemporalHint = (typeof TEMPORAL_HINTS)[number];
export const temporalHint = enumOf<TemporalHint>("temporal-hint", TEMPORAL_HINTS);

export interface TypingEntry {
  /** The requested top-level field, verbatim. */
  path: string;
  hint: TemporalHint;
}

export interface DescribeTypingResult {
  /** The catalog generation the answer was computed at; discard it across a catalog change. */
  catalogGeneration: number;
  /** One entry per requested path, in request order. */
  fields: TypingEntry[];
}

export const typingEntry = struct<TypingEntry>("typing-entry", [
  [0, "path", tstr],
  [1, "hint", temporalHint],
]);

export const describeTypingResult = struct<DescribeTypingResult>("describe-typing-result", [
  [0, "catalogGeneration", uint],
  [1, "fields", list(typingEntry)],
]);

/** Request bounds (`too_large` beyond them on the replica; refused locally first). */
export const DESCRIBE_TYPING_MAX_TYPES = 64;
export const DESCRIBE_TYPING_MAX_PATHS = 256;
