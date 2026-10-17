import { LOCAL_APPLICATION_BUILD, localApplicationHttpOrigin } from "../application/local-build.js";
import {
  MODEL_SETUP_LIMITS,
  type LegacyModelSetupIntent,
  type ModelPackOperation,
  type ModelPackPlan,
  type ModelPackSetupIntent,
  type ModelResourcePlan,
  type ModelResourceSetupIntent,
  type ModelResourceSetupRoundIntent,
  type ResourceSetupIntent,
  type ModelResourceSetupJournal,
  type ModelSetupIntent,
  type ModelSetupScope,
} from "./collection-setup-types.js";

const records = "original-model-operation";
const phases = ["prepared", "attempted", "confirmed", "verified"] as const;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const maxBytes = MODEL_SETUP_LIMITS.plaintextBytes;
const digest = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();
interface Stored {
  version: 1;
  revision: number;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}
export class AppCollectionSetupError extends Error {
  constructor(
    readonly reason:
      "binding" | "fenced" | "recovery_required" | "outcome_unknown",
  ) {
    super("Preserve the original collection setup operation.");
  }
}
function fail(reason: AppCollectionSetupError["reason"]): never {
  throw new AppCollectionSetupError(reason);
}
function exact(value: object, keys: string) {
  return Object.keys(value).sort().join() === keys;
}
function scopeCopy(scope: ModelSetupScope): ModelSetupScope {
  if (
    !scope ||
    !exact(scope, "account,collection,installation") ||
    Object.values(scope).some(
      (value) =>
        typeof value !== "string" ||
        !uuid.test(value) ||
        value === "00000000-0000-0000-0000-000000000000",
    )
  )
    fail("binding");
  return Object.freeze({
    account: scope.account,
    installation: scope.installation,
    collection: scope.collection,
  });
}
function unsafePathCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return value.includes("\\");
}
/** Original v1 decoder only. No legacy intent may be prepared or advanced. */
function legacyDefinitionOps(value: unknown): LegacyModelSetupIntent["ops"] {
  if (!Array.isArray(value) || value.length !== 2) fail("binding");
  const ops = value.map((op) => {
    if (
      !op ||
      typeof op !== "object" ||
      !exact(op, "doc,kind,mustNotExist,path") ||
      op.kind !== "resource_put" ||
      op.mustNotExist !== true ||
      typeof op.path !== "string" ||
      typeof op.doc !== "string" ||
      !op.doc.length ||
      op.path.length > 1024 ||
      !op.path.endsWith(".md") ||
      op.path.startsWith("/") ||
      unsafePathCharacters(op.path) ||
      op.path
        .split("/")
        .some((part: string) => !part || part === "." || part === "..")
    )
      fail("binding");
    return Object.freeze({
      kind: "resource_put" as const,
      path: op.path,
      doc: op.doc,
      mustNotExist: true as const,
    });
  });
  if (
    ops[0]!.path === ops[1]!.path ||
    encoder.encode(JSON.stringify(ops)).byteLength > maxBytes
  )
    fail("binding");
  return Object.freeze(ops) as unknown as LegacyModelSetupIntent["ops"];
}
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MODEL_SETUP_LIMITS.pathCodeUnits &&
    !value.startsWith("/") &&
    !unsafePathCharacters(value) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}
/** Copy the original ordered plan without rebuilding intent from file diffs. */
export function modelPackPlan(value: unknown): ModelPackPlan {
  const plan = value as ModelPackPlan;
  if (
    !plan ||
    typeof plan !== "object" ||
    !exact(plan, "assessmentDigest,ops,pack,readback") ||
    !plan.pack ||
    typeof plan.pack !== "object" ||
    !exact(plan.pack, "digest,id,version") ||
    typeof plan.pack.id !== "string" ||
    !plan.pack.id.length ||
    typeof plan.pack.version !== "string" ||
    !plan.pack.version.length ||
    typeof plan.pack.digest !== "string" ||
    !digest.test(plan.pack.digest) ||
    typeof plan.assessmentDigest !== "string" ||
    !digest.test(plan.assessmentDigest) ||
    !Array.isArray(plan.ops) ||
    !plan.ops.length ||
    plan.ops.length > MODEL_SETUP_LIMITS.operations ||
    !Array.isArray(plan.readback) ||
    !plan.readback.length ||
    plan.readback.length > MODEL_SETUP_LIMITS.readbacks
  )
    fail("binding");
  const ops = plan.ops.map((op): ModelPackOperation => {
    if (
      !op ||
      typeof op !== "object" ||
      !safePath(op.path) ||
      ("baseRevision" in op &&
        (typeof op.baseRevision !== "string" || !digest.test(op.baseRevision)))
    )
      fail("binding");
    const base = "baseRevision" in op ? { baseRevision: op.baseRevision! } : {};
    if (op.kind === "resource_put") {
      if (
        !exact(
          op,
          "baseRevision" in op
            ? "baseRevision,doc,kind,mustNotExist,path"
            : "doc,kind,mustNotExist,path",
        ) ||
        typeof op.doc !== "string" ||
        typeof op.mustNotExist !== "boolean"
      )
        fail("binding");
      return Object.freeze({
        kind: op.kind,
        path: op.path,
        doc: op.doc,
        ...base,
        mustNotExist: op.mustNotExist,
      });
    }
    if (
      op.kind !== "resource_delete" ||
      !exact(op, "baseRevision" in op ? "baseRevision,kind,path" : "kind,path")
    )
      fail("binding");
    return Object.freeze({ kind: op.kind, path: op.path, ...base });
  });
  const seen = new Set<string>();
  const readback = plan.readback.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !exact(entry, "doc,path") ||
      !safePath(entry.path) ||
      (entry.doc !== null && typeof entry.doc !== "string") ||
      seen.has(entry.path)
    )
      fail("binding");
    seen.add(entry.path);
    return Object.freeze({ path: entry.path, doc: entry.doc });
  });
  // Core may retire an already-absent managed target without emitting a delete.
  // Preserve its explicit null readback; never invent an operation. Core's
  // producer supplies retirement semantics, while this store enforces exact
  // immutable capture and put/delete-to-readback consistency.
  for (const op of ops) {
    const expected = readback.find((entry) => entry.path === op.path);
    if (
      !expected ||
      expected.doc !== (op.kind === "resource_put" ? op.doc : null)
    )
      fail("binding");
  }
  const captured = Object.freeze({
    pack: Object.freeze({
      id: plan.pack.id,
      version: plan.pack.version,
      digest: plan.pack.digest,
    }),
    assessmentDigest: plan.assessmentDigest,
    ops: Object.freeze(ops),
    readback: Object.freeze(readback),
  });
  if (encoder.encode(JSON.stringify(captured)).byteLength > maxBytes)
    fail("binding");
  return captured;
}
/** Distinct v3 data plan. Copy originals, never fabricate a capture/file inventory. */
export function modelResourcePlan(value: unknown): ModelResourcePlan {
  const p = value as ModelResourcePlan;
  if (
    !p ||
    typeof p !== "object" ||
    !exact(
      p,
      Object.hasOwn(p, "planKind")
        ? "assessmentDigest,packs,planKind,provisionDigest,resourceOps,resourceReadback,sources"
        : Object.hasOwn(p, "sourcePolicy")
          ? "assessmentDigest,packs,provisionDigest,resourceOps,resourceReadback,sourcePolicy,sources"
          : "assessmentDigest,packs,provisionDigest,resourceOps,resourceReadback,sources",
    ) ||
    (Object.hasOwn(p, "sourcePolicy") &&
      (p.sourcePolicy !== "current-only" || p.sources?.length !== 0)) ||
    typeof p.assessmentDigest !== "string" ||
    !digest.test(p.assessmentDigest) ||
    typeof p.provisionDigest !== "string" ||
    !digest.test(p.provisionDigest) ||
    !Array.isArray(p.packs) ||
    (!p.packs.length && p.planKind !== "configuration-only") ||
    p.packs.length > 16 ||
    !Array.isArray(p.resourceOps) ||
    !Array.isArray(p.sources) ||
    (!p.resourceOps.length && !p.sources.length) ||
    p.resourceOps.length + p.sources.length > MODEL_SETUP_LIMITS.operations ||
    !Array.isArray(p.resourceReadback) ||
    !p.resourceReadback.length ||
    p.resourceReadback.length + p.sources.length > MODEL_SETUP_LIMITS.readbacks
  )
    fail("binding");
  // Configuration-only setup may still carry the caller's starter records.
  if (Object.hasOwn(p, "planKind") && (p.planKind !== "configuration-only" || p.packs.length !== 0
    || !p.resourceOps.length || p.resourceOps.some(op => !op || op.kind !== "resource_put"
      || !["mdbase.yaml", "mdbase.provisions.yaml"].includes(op.path)))) fail("binding");
  const packIds = new Set<string>();
  const packs = p.packs.map((pack) => {
    if (
      !pack ||
      typeof pack !== "object" ||
      !exact(pack, "digest,id,version") ||
      typeof pack.id !== "string" ||
      !pack.id.length ||
      pack.id.length > 150 ||
      packIds.has(pack.id) ||
      typeof pack.version !== "string" ||
      !pack.version.length ||
      pack.version.length > 256 ||
      typeof pack.digest !== "string" ||
      !digest.test(pack.digest)
    )
      fail("binding");
    packIds.add(pack.id);
    return Object.freeze({ ...pack });
  });
  const paths = new Set<string>();
  const resourceReadback = p.resourceReadback.map((r) => {
    if (
      !r ||
      typeof r !== "object" ||
      !exact(r, "doc,path") ||
      !safePath(r.path) ||
      paths.has(r.path) ||
      (r.doc !== null && typeof r.doc !== "string")
    )
      fail("binding");
    paths.add(r.path);
    return Object.freeze({ ...r });
  });
  const resourceOps = p.resourceOps.map((op): ModelPackOperation => {
    if (!op || typeof op !== "object" || !safePath(op.path)) fail("binding");
    const hasBase = Object.hasOwn(op, "baseRevision");
    if (
      hasBase &&
      (typeof op.baseRevision !== "string" || !digest.test(op.baseRevision))
    )
      fail("binding");
    if (op.kind === "resource_put") {
      if (
        !exact(
          op,
          hasBase
            ? "baseRevision,doc,kind,mustNotExist,path"
            : "doc,kind,mustNotExist,path",
        ) ||
        typeof op.doc !== "string" ||
        typeof op.mustNotExist !== "boolean" ||
        (op.mustNotExist ? hasBase : !hasBase)
      )
        fail("binding");
    } else if (
      op.kind !== "resource_delete" ||
      !hasBase ||
      !exact(op, "baseRevision,kind,path")
    )
      fail("binding");
    const r = resourceReadback.find((r) => r.path === op.path);
    if (!r || r.doc !== (op.kind === "resource_put" ? op.doc : null))
      fail("binding");
    return Object.freeze({ ...op });
  });
  const ids = new Set<string>();
  const sources = p.sources.map((s) => {
    if (
      !s ||
      typeof s !== "object" ||
      !exact(s, "document,id,path") ||
      !safePath(s.path) ||
      paths.has(s.path) ||
      typeof s.id !== "string" ||
      !uuid.test(s.id) ||
      s.id === "00000000-0000-0000-0000-000000000000" ||
      ids.has(s.id) ||
      typeof s.document !== "string" ||
      !s.document.length
    )
      fail("binding");
    paths.add(s.path);
    ids.add(s.id);
    return Object.freeze({ ...s });
  });
  const captured = Object.freeze({
    ...(p.planKind === "configuration-only" ? { planKind: p.planKind } : {}),
    ...(p.sourcePolicy === "current-only"
      ? { sourcePolicy: p.sourcePolicy }
      : {}),
    assessmentDigest: p.assessmentDigest,
    provisionDigest: p.provisionDigest,
    packs: Object.freeze(packs),
    resourceOps: Object.freeze(resourceOps),
    resourceReadback: Object.freeze(resourceReadback),
    sources: Object.freeze(sources),
  });
  if (encoder.encode(JSON.stringify(captured)).byteLength > maxBytes)
    fail("binding");
  return captured;
}

export function decode(
  value: unknown,
  scope: ModelSetupScope,
  depth = 0,
): ModelSetupIntent {
  if (depth > 8) fail("binding");
  const v = value as ModelSetupIntent;
  if (
    !v ||
    typeof v !== "object" ||
    (v.version !== 1 &&
      v.version !== 2 &&
      v.version !== 3 &&
      v.version !== 4) ||
    !exact(
      v,
      v.version === 1
        ? "mutationId,ops,phase,scope,version"
        : v.version === 4
          ? "mutationId,phase,plan,previous,scope,version"
          : "mutationId,phase,plan,scope,version",
    ) ||
    typeof v.mutationId !== "string" ||
    !uuid.test(v.mutationId) ||
    v.mutationId === "00000000-0000-0000-0000-000000000000" ||
    !(phases.includes(v.phase as (typeof phases)[number])
      || (v.phase === "rejected" && (v.version === 3 || v.version === 4)))
  )
    fail("recovery_required");
  const bound = scopeCopy(v.scope);
  if (JSON.stringify(bound) !== JSON.stringify(scope)) fail("binding");
  if (v.version === 1)
    return Object.freeze({
      version: 1,
      scope: bound,
      mutationId: v.mutationId,
      ops: legacyDefinitionOps(v.ops),
      phase: v.phase,
    });
  if (v.version === 4) {
    const previous = decode(v.previous, scope, depth + 1);
    if (previous.phase !== "verified") fail("recovery_required");
    for (let prior = previous; ;) {
      if (prior.mutationId === v.mutationId) fail("binding");
      if (prior.version !== 4) break;
      prior = prior.previous;
    }
    const plan = modelResourcePlan(v.plan);
    if (
      plan.resourceOps.some(
        (op) =>
          op.kind !== "resource_put" ||
          (!op.mustNotExist &&
            ![
              "mdbase.yaml",
              "mdbase.lock.yaml",
              "mdbase.provisions.yaml",
            ].includes(op.path)),
      )
    )
      fail("binding");
    const intent: ModelResourceSetupRoundIntent = Object.freeze({
      version: 4,
      scope: bound,
      mutationId: v.mutationId,
      plan,
      phase: v.phase,
      previous,
    });
    if (
      encoder.encode(JSON.stringify({ ...intent, phase: "confirmed" }))
        .byteLength > maxBytes
    )
      fail("binding");
    return intent;
  }
  if (v.version === 3) {
    if (modelResourcePlan(v.plan).sourcePolicy !== undefined) fail("binding");
    const intent = Object.freeze({
      version: 3 as const,
      scope: bound,
      mutationId: v.mutationId,
      plan: modelResourcePlan(v.plan),
      phase: v.phase,
    });
    if (
      encoder.encode(JSON.stringify({ ...intent, phase: "confirmed" }))
        .byteLength > maxBytes
    )
      fail("binding");
    return intent;
  }
  const intent = Object.freeze({
    version: 2 as const,
    scope: bound,
    mutationId: v.mutationId,
    plan: modelPackPlan(v.plan),
    phase: v.phase,
  });
  // Reserve the longest phase spelling so a prepared plan can always advance.
  if (
    encoder.encode(JSON.stringify({ ...intent, phase: "confirmed" }))
      .byteLength > maxBytes
  )
    fail("binding");
  return intent;
}
function packIntent(value: ModelSetupIntent): ModelPackSetupIntent {
  if (value.version !== 2) fail("recovery_required");
  return value;
}
function openDatabase(database: string, signal: AbortSignal, current: () => void): Promise<IDBDatabase> {
  current();
  if (!globalThis.indexedDB) fail("recovery_required");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    let abandoned = false;
    const stop = () => {
      abandoned = true;
      signal.removeEventListener("abort", stop);
      try { request.transaction?.abort(); } catch { /* preserve committed state */ }
      reject(new AppCollectionSetupError("recovery_required"));
    };
    signal.addEventListener("abort", stop, { once: true });
    request.onupgradeneeded = () => {
      try {
        current();
        if (abandoned || request.result.objectStoreNames.length) fail("recovery_required");
        request.result.createObjectStore(records);
      } catch { stop(); }
    };
    request.onerror = request.onblocked = stop;
    request.onsuccess = () => {
      signal.removeEventListener("abort", stop);
      try {
        current();
        if (abandoned || request.result.objectStoreNames.length !== 1 || !request.result.objectStoreNames.contains(records)) fail("recovery_required");
        resolve(request.result);
      } catch {
        request.result.close();
        reject(new AppCollectionSetupError("recovery_required"));
      }
    };
  });
}

export interface AppCollectionSetupJournalOptions {
  /** Exact original BUILD-bound database and application namespace; no default,
   * guessed alias, migration or second record store. */
  readonly databaseName: string;
  readonly applicationNamespace: string;
  readonly scope: ModelSetupScope;
  readonly appOrigin: string;
  readonly cpOrigin: string;
  isCurrent(): boolean;
}

/** Fixed collection-owned origin ledger: one nonextractable AES handle and
 * authenticated ciphertext in a strict IDB CAS. Not an account KEK, generic KV,
 * XSS boundary, receipt authority, model readiness or collection Saved proof.
 * The installation owner supplies the actual tuple and lifetime, never the UI.
 */
export class AppCollectionSetupJournal implements ModelResourceSetupJournal {
  readonly scope: ModelSetupScope;
  private readonly namespace: string;
  private readonly binding: string;
  private stopped = false;
  /** The running operation. Every tab of the session shares this journal in the
   * Worker, so one tab's load can meet another tab's setup step: it waits its
   * turn instead of failing. Each operation re-reads and checks the stored phase. */
  private turn: Promise<void> = Promise.resolve();
  private readonly pins: string;
  private readonly current: AppCollectionSetupJournalOptions["isCurrent"];
  constructor(private readonly owner: AppCollectionSetupJournalOptions) {
    this.scope = scopeCopy(owner.scope);
    if (typeof owner.isCurrent !== "function" || [owner.databaseName, owner.applicationNamespace].some(value => typeof value !== "string" || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) fail("binding");
    this.current = owner.isCurrent;
    this.pins = JSON.stringify([owner.databaseName, owner.applicationNamespace, owner.appOrigin, owner.cpOrigin]);
    const app = new URL(owner.appOrigin),
      cp = new URL(owner.cpOrigin);
    if (
      app.origin !== owner.appOrigin ||
      cp.origin !== owner.cpOrigin ||
      (cp.protocol !== "https:" && !(LOCAL_APPLICATION_BUILD && localApplicationHttpOrigin(owner.cpOrigin)))
    )
      fail("binding");
    this.namespace = JSON.stringify([
      owner.appOrigin,
      owner.cpOrigin,
      owner.applicationNamespace,
      this.scope.account,
      this.scope.installation,
      this.scope.collection,
    ]);
    this.binding = JSON.stringify(this.scope);
  }
  close(): void {
    this.stopped = true;
  }
  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    let valid = false;
    try {
      valid = !this.stopped && this.owner.isCurrent === this.current && this.current.call(this.owner) === true &&
        JSON.stringify([this.owner.databaseName, this.owner.applicationNamespace, this.owner.appOrigin, this.owner.cpOrigin]) === this.pins &&
        JSON.stringify(scopeCopy(this.owner.scope)) === this.binding;
    } catch { /* unknown/replaced owner cannot authorize journal work */ }
    if (!valid) {
      this.stopped = true;
      fail("fenced");
    }
  }
  private async exclusive<T>(
    signal: AbortSignal,
    work: (db: IDBDatabase) => Promise<T>,
  ): Promise<T> {
    this.check(signal);
    const previous = this.turn;
    let done!: () => void;
    const mine = new Promise<void>((resolve) => { done = resolve; });
    // A caller that stops waiting never lets its successor overlap the previous one.
    this.turn = previous.then(() => mine);
    let db: IDBDatabase | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void previous.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      this.check(signal);
      db = await openDatabase(this.owner.databaseName, signal, () => this.check(signal));
      this.check(signal);
      const result = await work(db);
      this.check(signal);
      return result;
    } finally {
      db?.close();
      done();
    }
  }
  private read(
    db: IDBDatabase,
    signal: AbortSignal,
  ): Promise<Stored | undefined> {
    this.check(signal);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(records, "readonly");
      const request = tx.objectStore(records).get(this.namespace);
      const abort = () => tx.abort();
      signal.addEventListener("abort", abort, { once: true });
      tx.onabort = tx.onerror = () => {
        signal.removeEventListener("abort", abort);
        reject(new AppCollectionSetupError("recovery_required"));
      };
      tx.oncomplete = () => {
        signal.removeEventListener("abort", abort);
        resolve(request.result as Stored | undefined);
      };
    });
  }
  private aad(revision: number): Uint8Array<ArrayBuffer> {
    return encoder.encode(JSON.stringify([this.namespace, 1, revision]));
  }
  private async unwrap(
    stored: Stored | undefined,
    signal: AbortSignal,
  ): Promise<ModelSetupIntent | null> {
    this.check(signal);
    if (stored === undefined) return null;
    if (
      !stored ||
      !exact(stored, "ciphertext,iv,key,revision,version") ||
      stored.version !== 1 ||
      !Number.isSafeInteger(stored.revision) ||
      stored.revision < 1 ||
      !(stored.key instanceof CryptoKey) ||
      stored.key.extractable ||
      stored.key.type !== "secret" ||
      stored.key.algorithm.name !== "AES-GCM" ||
      !stored.key.usages.includes("encrypt") ||
      !stored.key.usages.includes("decrypt") ||
      !(stored.iv instanceof Uint8Array) ||
      stored.iv.byteLength !== 12 ||
      !(stored.ciphertext instanceof ArrayBuffer) ||
      stored.ciphertext.byteLength > maxBytes + 2048
    )
      fail("recovery_required");
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: stored.iv,
            additionalData: this.aad(stored.revision),
          },
          stored.key,
          stored.ciphertext,
        ),
      );
      this.check(signal);
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      );
      if (
        ((value as { version?: unknown } | null)?.version === 2 ||
          (value as { version?: unknown } | null)?.version === 3 ||
          (value as { version?: unknown } | null)?.version === 4) &&
        plaintext.byteLength > maxBytes
      )
        fail("recovery_required");
      return decode(value, this.scope);
    } catch (reason) {
      if (reason instanceof AppCollectionSetupError || signal.aborted)
        throw reason;
      throw new AppCollectionSetupError("recovery_required");
    } finally {
      plaintext?.fill(0);
    }
  }
  private async commit<T extends ModelPackSetupIntent | ResourceSetupIntent>(
    db: IDBDatabase,
    before: Stored | undefined,
    value: T,
    signal: AbortSignal,
  ): Promise<T> {
    this.check(signal);
    const revision = (before?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) fail("fenced");
    const key =
      before?.key ??
      (await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    if (plaintext.byteLength > maxBytes) {
      plaintext.fill(0);
      fail("binding");
    }
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: this.aad(revision) },
        key,
        plaintext,
      );
    } finally {
      plaintext.fill(0);
    }
    this.check(signal);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(records, "readwrite", {
          durability: "strict",
        });
        const abort = () => tx.abort();
        signal.addEventListener("abort", abort, { once: true });
        tx.onerror = tx.onabort = () => {
          signal.removeEventListener("abort", abort);
          reject(new AppCollectionSetupError("outcome_unknown"));
        };
        tx.oncomplete = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const store = tx.objectStore(records);
        const request = store.get(this.namespace);
        request.onsuccess = () => {
          try {
            this.check(signal);
            const current = request.result as Stored | undefined;
            if (
              (current === undefined) !== (before === undefined) ||
              (current && current.revision !== before?.revision)
            ) {
              tx.abort();
              return;
            }
            store.put(
              { version: 1, revision, key, iv, ciphertext } satisfies Stored,
              this.namespace,
            );
          } catch {
            tx.abort();
          }
        };
      });
    } catch (reason) {
      this.stopped = true;
      throw reason;
    }
    this.check(signal);
    return value;
  }
  load(signal: AbortSignal): Promise<ModelSetupIntent | null> {
    return this.exclusive(signal, async (db) =>
      this.unwrap(await this.read(db, signal), signal),
    );
  }
  prepare(
    plan: ModelPackPlan,
    signal: AbortSignal,
  ): Promise<ModelPackSetupIntent> {
    // Copy before the first await so caller mutation cannot alter the operation.
    const captured = modelPackPlan(plan);
    if (
      encoder.encode(
        JSON.stringify({
          version: 2,
          scope: this.scope,
          mutationId: this.scope.collection,
          plan: captured,
          phase: "confirmed",
        }),
      ).byteLength > maxBytes
    )
      fail("binding");
    return this.exclusive(signal, async (db) => {
      const stored = await this.read(db, signal),
        existing = await this.unwrap(stored, signal);
      if (existing) {
        const original = packIntent(existing);
        if (JSON.stringify(original.plan) !== JSON.stringify(captured))
          fail("binding");
        return original;
      }
      const intent = packIntent(
        decode(
          {
            version: 2,
            scope: this.scope,
            mutationId: crypto.randomUUID(),
            plan: captured,
            phase: "prepared",
          },
          this.scope,
        ),
      );
      return this.commit(db, stored, intent, signal);
    });
  }
  prepareResources(
    plan: ModelResourcePlan,
    signal: AbortSignal,
  ): Promise<ModelResourceSetupIntent> {
    // Copy complete original source UUIDs/bytes before the first await. No remint.
    const captured = modelResourcePlan(plan);
    if (captured.sourcePolicy !== undefined) fail("binding");
    if (
      encoder.encode(
        JSON.stringify({
          version: 3,
          scope: this.scope,
          mutationId: this.scope.collection,
          plan: captured,
          phase: "confirmed",
        }),
      ).byteLength > maxBytes
    )
      fail("binding");
    return this.exclusive(signal, async (db) => {
      const stored = await this.read(db, signal),
        existing = await this.unwrap(stored, signal);
      if (existing && !(existing.version === 3 && existing.phase === "rejected")) {
        // Only identical v3 recovery; existing v1/v2 can NEVER grow new seeds.
        // A rejected first intent applied nothing and is replaced below.
        if (existing.version !== 3) fail("recovery_required");
        if (JSON.stringify(existing.plan) !== JSON.stringify(captured))
          fail("binding");
        return existing;
      }
      const value = decode(
        {
          version: 3,
          scope: this.scope,
          mutationId: crypto.randomUUID(),
          plan: captured,
          phase: "prepared",
        },
        this.scope,
      );
      if (value.version !== 3) fail("binding");
      return this.commit(db, stored, value, signal);
    });
  }
  prepareResourceRound(
    plan: ModelResourcePlan,
    previousMutationId: string,
    signal: AbortSignal,
  ): Promise<ModelResourceSetupRoundIntent> {
    const captured = modelResourcePlan(plan);
    return this.exclusive(signal, async (db) => {
      const stored = await this.read(db, signal);
      let previous = await this.unwrap(stored, signal);
      // A rejected round applied nothing: chain from its verified predecessor.
      if (previous?.version === 4 && previous.phase === "rejected")
        previous = previous.previous;
      if (!previous || previous.mutationId !== previousMutationId)
        fail("binding");
      if (previous.phase !== "verified") fail("recovery_required");
      const value = decode(
        {
          version: 4,
          scope: this.scope,
          mutationId: crypto.randomUUID(),
          plan: captured,
          phase: "prepared",
          previous,
        },
        this.scope,
      );
      if (value.version !== 4) fail("binding");
      return this.commit(db, stored, value, signal);
    });
  }
  private advanceResource(
    id: string,
    phase: (typeof phases)[number],
    signal: AbortSignal,
  ): Promise<ResourceSetupIntent> {
    return this.exclusive(signal, async (db) => {
      const stored = await this.read(db, signal),
        existing = await this.unwrap(stored, signal);
      if (!existing || (existing.version !== 3 && existing.version !== 4))
        fail("recovery_required");
      if (existing.mutationId !== id) fail("binding");
      // A rejected intent is terminal; it never advances.
      if (existing.phase === "rejected") fail("recovery_required");
      const from = phases.indexOf(existing.phase),
        to = phases.indexOf(phase);
      if (to < from || to > from + 1) fail("recovery_required");
      if (to === from) return existing;
      const value = decode({ ...existing, phase }, this.scope);
      if (value.version !== 3 && value.version !== 4) fail("binding");
      return this.commit(db, stored, value, signal);
    });
  }
  recordResourceAttempt(
    id: string,
    signal: AbortSignal,
  ): Promise<ResourceSetupIntent> {
    return this.advanceResource(id, "attempted", signal);
  }
  recordResourceConfirmed(
    id: string,
    signal: AbortSignal,
  ): Promise<ResourceSetupIntent> {
    return this.advanceResource(id, "confirmed", signal);
  }
  recordResourceVerified(
    id: string,
    signal: AbortSignal,
  ): Promise<ResourceSetupIntent> {
    return this.advanceResource(id, "verified", signal);
  }
  recordResourceRejected(
    id: string,
    signal: AbortSignal,
  ): Promise<ResourceSetupIntent> {
    return this.exclusive(signal, async (db) => {
      const stored = await this.read(db, signal),
        existing = await this.unwrap(stored, signal);
      if (!existing || (existing.version !== 3 && existing.version !== 4))
        fail("recovery_required");
      if (existing.mutationId !== id) fail("binding");
      if (existing.phase === "rejected") return existing;
      if (existing.phase !== "attempted") fail("recovery_required");
      const value = decode({ ...existing, phase: "rejected" }, this.scope);
      if (value.version !== 3 && value.version !== 4) fail("binding");
      return this.commit(db, stored, value, signal);
    });
  }
  private advance(
    id: string,
    phase: (typeof phases)[number],
    signal: AbortSignal,
  ): Promise<ModelPackSetupIntent> {
    return this.exclusive(signal, async (db) => {
      const stored = await this.read(db, signal),
        loaded = await this.unwrap(stored, signal);
      if (!loaded) fail("recovery_required");
      const existing = packIntent(loaded);
      if (existing.mutationId !== id) fail("binding");
      // A rejected intent is terminal; it never advances.
      if (existing.phase === "rejected") fail("recovery_required");
      const from = phases.indexOf(existing.phase),
        to = phases.indexOf(phase);
      if (to < from || to > from + 1) fail("recovery_required");
      if (to === from) return existing;
      return this.commit(
        db,
        stored,
        packIntent(decode({ ...existing, phase }, this.scope)),
        signal,
      );
    });
  }
  recordAttempt(
    id: string,
    signal: AbortSignal,
  ): Promise<ModelPackSetupIntent> {
    return this.advance(id, "attempted", signal);
  }
  recordConfirmed(
    id: string,
    signal: AbortSignal,
  ): Promise<ModelPackSetupIntent> {
    return this.advance(id, "confirmed", signal);
  }
  recordVerified(
    id: string,
    signal: AbortSignal,
  ): Promise<ModelPackSetupIntent> {
    return this.advance(id, "verified", signal);
  }
}
