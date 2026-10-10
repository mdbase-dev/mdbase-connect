/**
 * `mdbase/node`: collections on disk.
 *
 * ```ts
 * import { Collection } from "mdbase/node";
 *
 * const col = await Collection.open("./notes");
 * const task = await col.create({ path: "tasks/a.md", frontmatter: { type: "task", status: "open" }, body: "…" });
 * const open = await col.query({ types: ["task"], where: "status == 'open'" });
 * await col.update("tasks/a.md", { set: { status: "done" }, ifRevision: task.revision });
 * await col.close();
 * ```
 *
 * The engine runs in a native addon (the same Rust `mdbase` crate), on a
 * thread per collection; every method is async and never blocks the event
 * loop. Errors are {@link MdbaseError} with a stable `code` and a `help` line.
 *
 * @packageDocumentation
 */

import { MdbaseError } from "../errors.js";
import { type NativeCollection, native } from "./native.js";

export { MdbaseError, type ErrorCode } from "../errors.js";
export type { Issue } from "../types.js";

/** A record. */
export interface Record {
  /** Stable ID (survives renames). */
  id: string;
  /** Collection path. */
  path: string;
  /** `sha256:…` of the file; pass as `ifRevision` to guard a write. */
  revision: string;
  /** Frontmatter as written. */
  frontmatter: { [key: string]: unknown };
  /** Frontmatter with type defaults applied, when requested. */
  effective: { [key: string]: unknown } | null;
  /** The body, when requested. */
  body: string | null;
  /** The whole file text, when requested. */
  document: string | null;
  /** The types this record belongs to. */
  types: string[];
  /** Validation issues, when requested. */
  issues: import("../types.js").Issue[];
}

/** A page of query results. */
export interface Page {
  records: Record[];
  /** False while the index is still being built. */
  complete: boolean;
  issues: import("../types.js").Issue[];
}

/** A record to operate on: a path, or `{ id }` from a previous read. */
export type Target = string | { id: string } | { path: string } | Record;

/** A spec 11 query object. */
export interface Query {
  types?: string[];
  /** CEL filter over the frontmatter; `file.path`, `now()`, `today()` are available. */
  where?: string;
  order_by?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  include_body?: boolean;
  timezone?: string;
  projections?: unknown;
  select?: string[];
  [member: string]: unknown;
}

export interface CreateInput {
  /** Omit to let the type's path policy derive it. */
  path?: string;
  /** Explicit type (sets the type key). */
  type?: string;
  frontmatter?: { [key: string]: unknown };
  body?: string;
  /** The whole file text instead of frontmatter + body. */
  document?: string;
}

export interface UpdateInput {
  set?: { [key: string]: unknown };
  unset?: string[];
  /** Add values to list fields (set semantics). */
  add?: { [key: string]: unknown[] };
  remove?: { [key: string]: unknown[] };
  body?: string;
  ifRevision?: string;
}

/** One operation in a batch. */
export type Op =
  | ({ op: "create" } & CreateInput)
  | ({ op: "update"; target: Target } & UpdateInput)
  | { op: "replace"; target: Target; document: string; ifRevision?: string }
  | { op: "delete"; target: Target; ifRevision?: string }
  | { op: "rename"; target: Target; to: string; updateRefs?: boolean; ifRevision?: string };

export interface Change {
  id: string;
  path: string;
  kind: "put" | "remove";
}

export interface Changes {
  changes: Change[];
  /** Pass to the next call. */
  cursor: string;
  /** History before the cursor is gone: re-read everything. */
  reset: boolean;
}

export interface Hold {
  id: string;
  path: string;
  reason: string;
  since: number;
}

export type HoldResolution =
  | { how: "keep_mine" }
  | { how: "take_theirs" }
  | { how: "use"; text: string }
  | { how: "delete" }
  | { how: "keep_both" };

export interface Status {
  pending: number;
  holds: number;
  unresolved: number;
}

export interface Links {
  outgoing: { target: string; resolved: string | null }[];
  backlinks: string[];
}

export interface Catalog {
  valid: boolean;
  spec_version: string | null;
  types: { name: string; path: string; version: number | null }[];
  contracts: { id: string; version: string; contract_type: string; digest: string; path: string }[];
  issues: { code: string; message: string; location: string | null; type: string | null }[];
}

export interface OpenOptions {
  /** Where to keep the index and identity. Default `<root>/.mdbase/library`. */
  stateDir?: string;
  /** Use the constrained (mobile) resource profile. */
  constrained?: boolean;
  /** IANA zone for `today()` and lifecycle dates. */
  timezone?: string;
  /** Open even if another host left a descriptor behind. Never overrides a held OS lock. */
  takeOver?: boolean;
  /** Your app's name and version (diagnostics). */
  client?: [name: string, version: string];
}

export interface InitOptions {
  name?: string;
  timezone?: string;
}

interface Envelope {
  ok?: unknown;
  error?: { code: string; message: string; help?: string; location?: string; details?: unknown } & { [k: string]: unknown };
  __channel?: number;
}

function unwrap(v: unknown): unknown {
  const env = (typeof v === "string" ? JSON.parse(v) : v) as Envelope;
  if (env && typeof env === "object" && env.error) {
    const { code, message, help, location, details, ...rest } = env.error;
    const extra: { location?: string; details?: unknown } = {};
    if (location !== undefined) extra.location = location;
    extra.details = details !== undefined ? details : Object.keys(rest).length ? rest : undefined;
    throw new MdbaseError(code, message, help, extra);
  }
  return env?.ok;
}

function targetArg(t: Target): unknown {
  if (typeof t === "string") return t;
  if ("id" in t && typeof t.id === "string") return { id: t.id };
  return t;
}

/** An open collection. One process hosts a folder at a time. */
export class Collection {
  readonly #native: NativeCollection;
  /** The absolute root. */
  readonly root: string;

  private constructor(n: NativeCollection, root: string) {
    this.#native = n;
    this.root = root;
  }

  /**
   * Open the collection at `root`.
   * @throws {MdbaseError} `not_a_collection` if there is no `mdbase.yaml`;
   * `already_hosted` if the daemon, Obsidian or another process hosts it.
   */
  static async open(root: string, options: OpenOptions = {}): Promise<Collection> {
    return Collection.#attach(await native().Collection.open(root, JSON.stringify(options)));
  }

  /** Create the folder and `mdbase.yaml` if missing, then open. */
  static async init(root: string, init: InitOptions = {}, options: OpenOptions = {}): Promise<Collection> {
    return Collection.#attach(await native().Collection.init(root, JSON.stringify(init), JSON.stringify(options)));
  }

  /** `open`/`init` resolve `{ok: true, __channel}` or `{error}`. */
  static async #attach(text: string): Promise<Collection> {
    const envelope = JSON.parse(text) as Envelope;
    unwrap(envelope);
    const channel = envelope.__channel;
    if (typeof channel !== "number") {
      throw new MdbaseError("native_unavailable", "the native addon returned no collection channel", "Rebuild the addon; the TypeScript wrapper and the binary disagree.");
    }
    const n = native().Collection.attach(channel);
    const root = unwrap(await n.call("root", "{}")) as string;
    return new Collection(n, root);
  }

  async #call(op: string, args: unknown = {}): Promise<unknown> {
    return unwrap(await this.#native.call(op, JSON.stringify(args)));
  }

  /** One record with its body, or `null`. */
  async get(target: Target): Promise<Record | null> {
    return (await this.#call("get", { target: targetArg(target) })) as Record | null;
  }

  /** One record's whole file text, or `null`. */
  async document(target: Target): Promise<string | null> {
    return (await this.#call("document", { target: targetArg(target) })) as string | null;
  }

  /** Run a spec 11 query. */
  async query(query: Query): Promise<Page> {
    return (await this.#call("query", { query })) as Page;
  }

  /** Create a record and return it. */
  async create(input: CreateInput): Promise<Record> {
    const [r] = (await this.#call("apply", { ops: [{ op: "create", ...input }] })) as Record[];
    return r!;
  }

  /** Update a record and return it. */
  async update(target: Target, input: UpdateInput): Promise<Record> {
    const [r] = (await this.#call("apply", { ops: [{ op: "update", target: targetArg(target), ...input }] })) as Record[];
    return r!;
  }

  /** Replace a record's whole document and return it. */
  async replace(target: Target, document: string, options: { ifRevision?: string } = {}): Promise<Record> {
    const [r] = (await this.#call("apply", {
      ops: [{ op: "replace", target: targetArg(target), document, ...options }],
    })) as Record[];
    return r!;
  }

  /** Delete a record. */
  async delete(target: Target, options: { ifRevision?: string } = {}): Promise<void> {
    await this.#call("apply", { ops: [{ op: "delete", target: targetArg(target), ...options }] });
  }

  /** Move a record, rewriting links to it. */
  async rename(target: Target, to: string, options: { updateRefs?: boolean; ifRevision?: string } = {}): Promise<Record> {
    const [r] = (await this.#call("apply", {
      ops: [{ op: "rename", target: targetArg(target), to, ...options }],
    })) as Record[];
    return r!;
  }

  /** Apply several operations as one atomic mutation. Returns the written records (deletes contribute none). */
  async batch(ops: Op[]): Promise<Record[]> {
    const prepared = ops.map((o) => ("target" in o ? { ...o, target: targetArg(o.target) } : o));
    return (await this.#call("batch", { ops: prepared })) as Record[];
  }

  /** Validate every record, plus type/contract files the engine rejected. Only paths with issues. */
  async validate(): Promise<{ path: string; issues: import("../types.js").Issue[] }[]> {
    return (await this.#call("validate")) as { path: string; issues: import("../types.js").Issue[] }[];
  }

  /** Validate one record. */
  async validateOne(target: Target): Promise<import("../types.js").Issue[]> {
    return (await this.#call("validate_one", { target: targetArg(target) })) as import("../types.js").Issue[];
  }

  /** The names of the collection's types. */
  async types(): Promise<string[]> {
    return (await this.#call("types")) as string[];
  }

  /** The compiled catalog (summary). For the full catalog use `loadCatalog` from `mdbase`. */
  async catalog(): Promise<Catalog> {
    return (await this.#call("catalog")) as Catalog;
  }

  /** Links out of and into a record. */
  async links(target: Target): Promise<Links> {
    return (await this.#call("links", { target: targetArg(target) })) as Links;
  }

  /** Changes since `cursor`. Without one, returns the current cursor and no changes. */
  async changes(cursor?: string): Promise<Changes> {
    return (await this.#call("changes", cursor ? { cursor } : {})) as Changes;
  }

  /** Files the engine set aside instead of overwriting. */
  async holds(): Promise<Hold[]> {
    return (await this.#call("holds")) as Hold[];
  }

  /** Resolve a hold. */
  async resolveHold(id: string, how: HoldResolution): Promise<void> {
    await this.#call("resolve_hold", { id, ...how });
  }

  /** Pending writes, holds and conflicts. */
  async status(): Promise<Status> {
    return (await this.#call("status")) as Status;
  }

  /** Walk the folder for edits other programs made. */
  async rescan(): Promise<void> {
    await this.#call("rescan");
  }

  /** Run the engine's timers (deletes, moves) until quiet, waiting up to `maxWaitMs`. */
  async settle(maxWaitMs = 5000): Promise<boolean> {
    return (await this.#call("settle", { maxWaitMs })) as boolean;
  }

  /** Flush and release the folder. Idempotent. */
  async close(): Promise<void> {
    await this.#native.close();
  }
}
