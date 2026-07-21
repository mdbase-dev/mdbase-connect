import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import type { JsonObject, SyncMutation, SyncMutationReceipt, SyncRecord } from "@mdbase/connect-protocol";
import type { SyncTransport } from "./index.js";
import { SyncError } from "./index.js";

interface MirrorEntry {
  path: string;
  revision: string;
  hash: string;
  record?: SyncRecord;
}

interface PendingMirrorMutation {
  mutation: SyncMutation;
  local_path: string;
  local_hash: string | null;
}

interface MirrorState {
  protocol_version: 1;
  replica_id: string;
  scope_epoch: number;
  cursor: number;
  records: Record<string, MirrorEntry>;
  resources?: Record<string, MirrorEntry>;
  mode?: "read_only" | "read_write";
  pending?: PendingMirrorMutation[];
  conflicts?: Record<string, SyncMutationReceipt>;
}

/** Receive-only materialization of a sync replica into ordinary Markdown files. */
export class DirectoryMirror<Frontmatter extends JsonObject = JsonObject> {
  private readonly root: string;

  constructor(
    root: string,
    private readonly replicaId: string,
    private readonly transport: SyncTransport<Frontmatter>,
    private readonly mode: "read_only" | "read_write" = "read_only"
  ) {
    this.root = resolve(root);
  }

  async sync(): Promise<void> {
    const state = await this.readState();
    if (!state) {
      await this.rebuild();
      // A writable first sync is also the import path for an existing local
      // directory: rebuild establishes the remote baseline, then a normal
      // pass journals and conditionally uploads files that were not remote.
      if (this.mode === "read_write") await this.sync();
      return;
    }
    if (this.mode === "read_write") {
      if (Object.keys(state.conflicts ?? {}).length) {
        throw new WritableMirrorConflictError(
          Object.keys(state.conflicts ?? {})[0]!,
          "A local conflict must be resolved before writable sync can continue."
        );
      }
      await this.flushPending(state);
      await this.captureLocalChanges(state);
      await this.flushPending(state);
    } else {
      await this.assertUndiverged(state);
    }
    while (true) {
      const page = await this.transport.changes(state.cursor, 200);
      if (page.scope_epoch !== state.scope_epoch || page.reset_required) {
        await this.rebuild(state);
        return;
      }
      for (const event of page.events) {
        if (event.type === "put") await this.put(state, event.record);
        else await this.remove(state, event.record_id, event.previous_path);
      }
      state.cursor = page.cursor;
      await this.writeState(state);
      if (!page.has_more) return;
    }
  }

  private async rebuild(prior?: MirrorState): Promise<void> {
    const session = await this.transport.openSession();
    if (session.replica_id !== this.replicaId || session.mode !== this.mode) {
      throw new SyncError(
        "invalid_mirror_session",
        `Filesystem mirror requires its own ${this.mode.replace("_", "-")} replica.`
      );
    }
    const state: MirrorState = {
      protocol_version: 1,
      replica_id: this.replicaId,
      scope_epoch: session.scope_epoch,
      cursor: session.head,
      records: {},
      resources: {},
      mode: this.mode,
      pending: [],
      conflicts: {}
    };
    for (const resource of session.resources.documents ?? []) {
      await this.putResource(state, resource, prior);
    }
    let page: string | undefined;
    do {
      const snapshot = await this.transport.snapshot(session.snapshot_id, page);
      for (const record of snapshot.records) await this.put(state, record, prior);
      page = snapshot.next_page;
    } while (page);
    if (prior) {
      for (const [recordId, entry] of Object.entries(prior.records)) {
        if (!state.records[recordId]) await this.remove(prior, recordId, entry.path);
      }
      for (const [path, entry] of Object.entries(prior.resources ?? {})) {
        if (!state.resources?.[path]) await this.removeResource(prior, path, entry);
      }
    }
    await this.writeState(state);
  }

  private async put(
    state: MirrorState,
    record: SyncRecord<Frontmatter>,
    managedState: MirrorState | undefined = state,
    acceptedHash?: string | null
  ): Promise<void> {
    const path = await this.safePath(record.path);
    const document = markdown(record);
    const existing = await readOptional(path);
    const prior = managedState?.records[record.record_id];
    if (existing !== null && existing !== document) {
      const existingHash = digest(existing);
      if (
        (!prior || prior.path !== record.path || existingHash !== prior.hash)
        && (acceptedHash === undefined || existingHash !== acceptedHash)
      ) {
        throw new MirrorDivergenceError(record.record_id, record.path);
      }
    }
    if (prior && prior.path !== record.path) {
      await this.remove(managedState!, record.record_id, prior.path);
    }
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, document);
    state.records[record.record_id] = {
      path: record.path,
      revision: record.revision,
      hash: digest(document),
      record
    };
  }

  private async remove(state: MirrorState, recordId: string, pathValue: string): Promise<void> {
    const entry = state.records[recordId];
    const path = await this.safePath(entry?.path ?? pathValue);
    const existing = await readOptional(path);
    if (existing !== null && entry && digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(recordId, entry.path);
    }
    if (existing !== null) await unlink(path);
    delete state.records[recordId];
  }

  private async putResource(
    state: MirrorState,
    resource: { path: string; revision: string; document: string },
    managedState?: MirrorState
  ): Promise<void> {
    const path = await this.safePath(resource.path);
    const existing = await readOptional(path);
    const prior = managedState?.resources?.[resource.path];
    if (existing !== null && existing !== resource.document && (!prior || digest(existing) !== prior.hash)) {
      throw new MirrorDivergenceError(`resource:${resource.path}`, resource.path);
    }
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, resource.document);
    state.resources ??= {};
    state.resources[resource.path] = {
      path: resource.path,
      revision: resource.revision,
      hash: digest(resource.document)
    };
  }

  private async removeResource(state: MirrorState, pathValue: string, entry: MirrorEntry): Promise<void> {
    const path = await this.safePath(pathValue);
    const existing = await readOptional(path);
    if (existing !== null && digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(`resource:${pathValue}`, pathValue);
    }
    if (existing !== null) await unlink(path);
    if (state.resources) delete state.resources[pathValue];
  }

  async resolveConflict(recordId: string, resolution: "local" | "remote"): Promise<void> {
    if (this.mode !== "read_write") {
      throw new SyncError("mirror_read_only", "Receive-only mirrors do not contain writable conflicts.");
    }
    const state = await this.readState();
    const receipt = state?.conflicts?.[recordId];
    if (!state || !receipt) {
      throw new SyncError("mirror_conflict_not_found", "Writable mirror conflict was not found.");
    }
    if (receipt.status === "rejected") {
      throw new WritableMirrorRejectedError(recordId, receipt.error.code, receipt.error.message);
    }
    if (receipt.status === "conflicted") {
      const current = receipt.conflict.current;
      if (resolution === "remote") {
        if (current) {
          const currentPath = await this.safePath(current.path);
          const existing = await readOptional(currentPath);
          await this.put(
            state,
            current as SyncRecord<Frontmatter>,
            state,
            existing === null ? null : digest(existing)
          );
        } else {
          const entry = state.records[recordId];
          if (entry) {
            const path = await this.safePath(entry.path);
            if (await readOptional(path) !== null) await unlink(path);
            delete state.records[recordId];
          }
        }
      } else if (current) {
        state.records[recordId] = {
          path: current.path,
          revision: current.revision,
          hash: digest(markdown(current)),
          record: current
        };
      } else {
        delete state.records[recordId];
      }
    }
    if (state.pending?.[0]?.mutation.causal_predecessor === receipt.mutation_id) {
      delete state.pending[0].mutation.causal_predecessor;
    }
    delete state.conflicts![recordId];
    const conflictPath = await this.conflictPath(recordId);
    if (await readOptional(conflictPath) !== null) await unlink(conflictPath);
    await this.writeState(state);
  }

  private async captureLocalChanges(state: MirrorState): Promise<void> {
    const resourcePaths = new Set(Object.keys(state.resources ?? {}));
    for (const [path, entry] of Object.entries(state.resources ?? {})) {
      const value = await readOptional(await this.safePath(path));
      if (value === null || digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(`resource:${path}`, path);
      }
    }
    const files = await markdownFiles(this.root, resourcePaths);
    const local = new Map<string, { document: string; hash: string }>();
    for (const path of files) {
      const document = await readFile(await this.safePath(path), "utf8");
      local.set(path, { document, hash: digest(document) });
    }
    const managedPaths = new Map(
      Object.entries(state.records).map(([recordId, entry]) => [entry.path, recordId])
    );
    const untracked = new Set([...local.keys()].filter((path) => !managedPaths.has(path)));
    const missing = new Set(
      Object.entries(state.records)
        .filter(([, entry]) => !local.has(entry.path))
        .map(([recordId]) => recordId)
    );
    const queued: PendingMirrorMutation[] = [];
    let predecessor: string | undefined;
    const queue = (
      mutation: Omit<SyncMutation, "mutation_id" | "replica_id" | "scope_epoch" | "created_at">,
      localPath: string,
      localHash: string | null
    ) => {
      const mutationId = randomUUID();
      queued.push({
        mutation: {
          ...mutation,
          mutation_id: mutationId,
          replica_id: this.replicaId,
          scope_epoch: state.scope_epoch,
          created_at: new Date().toISOString(),
          ...(predecessor ? { causal_predecessor: predecessor } : {})
        },
        local_path: localPath,
        local_hash: localHash
      });
      predecessor = mutationId;
    };

    for (const recordId of [...missing]) {
      const entry = state.records[recordId]!;
      const candidates = [...untracked].filter((path) => local.get(path)?.hash === entry.hash);
      if (candidates.length !== 1) continue;
      const target = candidates[0]!;
      queue({
        operation: "rename",
        record_id: recordId,
        base_revision: entry.revision,
        input: { path: target }
      }, target, local.get(target)!.hash);
      missing.delete(recordId);
      untracked.delete(target);
    }

    for (const [recordId, entry] of Object.entries(state.records)) {
      if (missing.has(recordId)) continue;
      const value = local.get(entry.path);
      if (!value || value.hash === entry.hash) continue;
      const record = entry.record;
      if (!record) {
        throw new SyncError(
          "mirror_state_upgrade_required",
          "Run a receive sync before editing this older writable mirror."
        );
      }
      const parsed = parseMarkdown(value.document, entry.path);
      queue({
        operation: "update",
        record_id: recordId,
        base_revision: entry.revision,
        input: {
          patch: frontmatterPatch(record.frontmatter, parsed.frontmatter),
          body: parsed.body
        }
      }, entry.path, value.hash);
    }

    for (const recordId of missing) {
      const entry = state.records[recordId]!;
      queue({
        operation: "delete",
        record_id: recordId,
        base_revision: entry.revision,
        input: {}
      }, entry.path, null);
    }

    for (const path of untracked) {
      const value = local.get(path)!;
      const parsed = parseMarkdown(value.document, path);
      queue({
        operation: "create",
        record_id: randomUUID(),
        input: { path, frontmatter: parsed.frontmatter, body: parsed.body }
      }, path, value.hash);
    }
    if (queued.length) {
      state.pending!.push(...queued);
      await this.writeState(state);
    }
  }

  private async flushPending(state: MirrorState): Promise<void> {
    while (state.pending?.length) {
      const pending = state.pending[0]!;
      const localPath = await this.safePath(pending.local_path);
      const localDocument = await readOptional(localPath);
      const localHash = localDocument === null ? null : digest(localDocument);
      if (localHash !== pending.local_hash) {
        throw new SyncError(
          "pending_local_changed",
          `Local edits at ${pending.local_path} changed while an earlier upload was pending.`
        );
      }
      const receipt = await this.transport.mutate(pending.mutation);
      if (receipt.status === "applied" || receipt.status === "previously_applied") {
        if (receipt.record) {
          await this.put(
            state,
            receipt.record,
            state,
            pending.local_hash
          );
        } else {
          delete state.records[pending.mutation.record_id];
        }
        state.pending.shift();
        await this.writeState(state);
        continue;
      }
      state.pending.shift();
      state.conflicts ??= {};
      state.conflicts[pending.mutation.record_id] = receipt;
      const conflictPath = await this.conflictPath(pending.mutation.record_id);
      await mkdir(dirname(conflictPath), { recursive: true });
      await atomicWrite(
        conflictPath,
        `${JSON.stringify(receipt, null, 2)}\n`
      );
      await this.writeState(state);
      if (receipt.status === "conflicted") {
        throw new WritableMirrorConflictError(
          pending.mutation.record_id,
          `Hosted and local changes conflict at ${pending.local_path}.`
        );
      }
      if (receipt.status !== "rejected") {
        throw new SyncError("invalid_mutation_receipt", "Hosted provider returned an invalid mutation receipt.");
      }
      throw new WritableMirrorRejectedError(
        pending.mutation.record_id,
        receipt.error.code,
        receipt.error.message
      );
    }
  }

  private conflictPath(recordId: string): Promise<string> {
    return this.safePath(`.mdbase/conflicts/${recordId}.json`);
  }

  private async safePath(relative: string): Promise<string> {
    if (relative.startsWith("/") || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new SyncError("invalid_path", "Mirror received an unsafe record path.");
    }
    const root = await realpath(this.root);
    const path = resolve(root, relative);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new SyncError("path_traversal", "Mirror path escaped its collection root.");
    }
    const parts = relative.split("/");
    let candidate = root;
    for (const [index, part] of parts.entries()) {
      candidate = join(candidate, part);
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          throw new SyncError("symlink_denied", "Mirror paths cannot traverse symbolic links.");
        }
        if (index < parts.length - 1 && !metadata.isDirectory()) {
          throw new SyncError("invalid_path", "Mirror path parent is not a directory.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return path;
  }

  private async readState(): Promise<MirrorState | null> {
    const value = await readOptional(await this.safePath(".mdbase/connect-sync.json"));
    if (value === null) return null;
    try {
      const state = JSON.parse(value) as MirrorState;
      if (state.protocol_version !== 1 || state.replica_id !== this.replicaId) throw new Error();
      state.resources ??= {};
      state.pending ??= [];
      state.conflicts ??= {};
      state.mode ??= "read_only";
      if (state.mode !== this.mode) {
        throw new SyncError(
          "mirror_mode_mismatch",
          `Mirror metadata belongs to a ${state.mode.replace("_", "-")} replica.`
        );
      }
      return state;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError("invalid_mirror_state", "Mirror metadata is corrupt or belongs to another replica.");
    }
  }

  private async writeState(state: MirrorState): Promise<void> {
    const statePath = await this.safePath(".mdbase/connect-sync.json");
    await mkdir(dirname(statePath), { recursive: true });
    await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async assertUndiverged(state: MirrorState): Promise<void> {
    for (const [recordId, entry] of Object.entries(state.records)) {
      const value = await readOptional(await this.safePath(entry.path));
      if (value === null || digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(recordId, entry.path);
      }
    }
    for (const [path, entry] of Object.entries(state.resources ?? {})) {
      const value = await readOptional(await this.safePath(entry.path));
      if (value === null || digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(`resource:${path}`, entry.path);
      }
    }
  }
}

export class MirrorDivergenceError extends SyncError {
  constructor(public readonly recordId: string, public readonly path: string) {
    super("mirror_diverged", `Local edits at ${path} must be resolved before the mirror can continue.`);
  }
}

export class WritableDirectoryMirror<Frontmatter extends JsonObject = JsonObject>
  extends DirectoryMirror<Frontmatter> {
  constructor(root: string, replicaId: string, transport: SyncTransport<Frontmatter>) {
    super(root, replicaId, transport, "read_write");
  }
}

export class WritableMirrorConflictError extends SyncError {
  constructor(public readonly recordId: string, message: string) {
    super("writable_mirror_conflict", message);
  }
}

export class WritableMirrorRejectedError extends SyncError {
  constructor(
    public readonly recordId: string,
    public readonly rejectionCode: string,
    message: string
  ) {
    super("writable_mirror_rejected", `${rejectionCode}: ${message}`);
  }
}

function markdown(record: SyncRecord): string {
  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = record.body ? `\n${record.body.replace(/^\n/, "")}` : "";
  return `---\n${yaml}\n---\n${body}`;
}

function parseMarkdown(document: string, path: string): { frontmatter: JsonObject; body: string } {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new SyncError("invalid_markdown", `Writable mirror file ${path} requires YAML frontmatter.`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!);
  } catch {
    throw new SyncError("invalid_frontmatter", `Writable mirror file ${path} has invalid YAML frontmatter.`);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new SyncError("invalid_frontmatter", `Writable mirror file ${path} requires object frontmatter.`);
  }
  return { frontmatter: frontmatter as JsonObject, body: match[2] ?? "" };
}

function frontmatterPatch(before: JsonObject, after: JsonObject): JsonObject {
  const patch: JsonObject = { ...after };
  for (const field of Object.keys(before)) {
    if (!(field in after)) patch[field] = null;
  }
  return patch;
}

async function markdownFiles(root: string, excluded: Set<string>): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".mdbase") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const pathValue = relative(root, path).split(sep).join("/");
        if (!excluded.has(pathValue)) files.push(pathValue);
      }
    }
  }
  await visit(root);
  files.sort();
  return files;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.mdbase-${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
