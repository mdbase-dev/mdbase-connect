/** Current selected-collection types/capabilities assessment. READ only.
 * The factory composes other manifest facets and ORIGINAL setup recovery. */
import type { MdbaseClient, ChangesWatch } from "../client.js";
import type { Session } from "../session.js";
import type { DescribeResult, ResourceView } from "../wire.js";
import { mdbaseError, isMdbaseError } from "../errors.js";

export interface AppCollectionReadinessRequirements {
  /** Factory projects only the canonical VALIDATED v2 required groups. */
  readonly capabilityContractVersion: 2;
  readonly requiredNativeCapabilities: readonly string[];
  readonly contracts: readonly {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  }[];
}
export interface AppCollectionReadinessBinding {
  readonly collection: string;
  readonly generation: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
export type AppCollectionReadinessReason =
  | "capability_missing"
  | "contract_missing"
  | "contract_mismatch"
  | "implementation_missing"
  | "catalog_invalid"
  | "catalog_response"
  | "unavailable"
  | "unsupported"
  | "changed"
  | "fenced"
  | "busy"
  | "budget";
export interface AppCollectionReadinessProblem {
  readonly reason: AppCollectionReadinessReason;
}
export interface AppCollectionReadinessWitness {
  readonly collection: string;
  readonly generation: string;
  /** Actual confirmed native inventory cut, NOT an invented catalog generation. */
  readonly resources: readonly Readonly<
    Pick<ResourceView, "path" | "revision" | "size" | "state">
  >[];
}
export interface AppCollectionReadinessAssessment {
  readonly status: "ready" | "setup_required" | "incompatible";
  readonly problem: AppCollectionReadinessProblem | null;
  readonly witness: AppCollectionReadinessWitness;
}
export interface AppCollectionReadinessSnapshot {
  readonly checking: boolean;
  readonly assessment: AppCollectionReadinessAssessment | null;
  readonly problem: AppCollectionReadinessProblem | null;
}
const MAX_RESOURCES = 4096,
  MAX_BYTES = 2 * 1024 * 1024,
  MAX_PAGES = 64;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const hash = /^sha256:[0-9a-f]{64}$/;
const text = (value: unknown, max = 4096): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  new TextEncoder().encode(value).length <= max;
const error = (reason: AppCollectionReadinessReason) =>
  mdbaseError(
    reason === "fenced"
      ? "unauthenticated"
      : reason === "budget"
        ? "too_large"
        : "unavailable",
    "collection readiness unavailable",
    `readiness_${reason}`,
  );
function requirements(
  source: AppCollectionReadinessRequirements,
): AppCollectionReadinessRequirements {
  if (source.capabilityContractVersion !== 2)
    throw mdbaseError(
      "upgrade_required",
      "unsupported readiness capability projection",
      "readiness_capability_version",
    );
  if (
    !Array.isArray(source.contracts) ||
    source.contracts.length > 128 ||
    !Array.isArray(source.requiredNativeCapabilities) ||
    source.requiredNativeCapabilities.length > 64
  )
    throw error("unsupported");
  const contracts = source.contracts.map((row) => {
    if (
      !row ||
      !text(row.id, 256) ||
      !text(row.version, 128) ||
      !hash.test(row.digest)
    )
      throw error("unsupported");
    return Object.freeze({
      id: row.id,
      version: row.version,
      digest: row.digest,
    });
  });
  const caps = source.requiredNativeCapabilities.map((cap) => {
    if (!text(cap, 128)) throw error("unsupported");
    return cap;
  });
  if (
    new Set(contracts.map((row) => JSON.stringify([row.id, row.version])))
      .size !== contracts.length ||
    new Set(caps).size !== caps.length
  )
    throw error("unsupported");
  return Object.freeze({
    capabilityContractVersion: 2,
    contracts: Object.freeze(contracts),
    requiredNativeCapabilities: Object.freeze(caps),
  });
}
function problem(
  reason: AppCollectionReadinessReason,
): AppCollectionReadinessProblem {
  return Object.freeze({ reason });
}
function reasonOf(value: unknown): AppCollectionReadinessReason {
  try {
    if (isMdbaseError(value)) {
      if (value.code === "unauthenticated" || value.code === "cancelled")
        return "fenced";
      if (value.code === "too_large") return "budget";
      if (value.code === "upgrade_required" || value.code === "forbidden")
        return "unsupported";
      if (
        value.reason === "readiness_changed" ||
        value.reason === "cursor_stale" ||
        value.reason === "cursor_expired"
      )
        return "changed";
      if (value.reason === "readiness_busy") return "busy";
      if (value.reason === "readiness_catalog_response")
        return "catalog_response";
    }
  } catch {
    /* Diagnostic getters never escape. */
  }
  return "unavailable";
}
function statusStamp(client: MdbaseClient): string {
  const s = client.status;
  return JSON.stringify([
    s.mode,
    s.confirmedThrough,
    s.headKnown,
    s.pending,
    s.holds,
    s.unresolved,
    s.connection,
    s.installing,
    s.resyncing,
    s.incidents.map((i) => i.kind),
    s.confirmedHead,
  ]);
}

export class AppCollectionReadiness {
  private readonly declared: AppCollectionReadinessRequirements;
  private readonly binding: AppCollectionReadinessBinding;
  private readonly lifetime = new AbortController();
  private readonly readSignal: AbortSignal;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: AppCollectionReadinessSnapshot = Object.freeze({
    checking: false,
    assessment: null,
    problem: null,
  });
  private watch: ChangesWatch | null = null;
  private stops: Array<() => void> = [];
  private pending: Promise<AppCollectionReadinessAssessment> | null = null;
  private epoch = 0;
  private dirty = false;
  private scheduled = false;
  private closed = false;
  private lastStatus: string | null = null;
  private assessedSession: Session | undefined;
  private assessedEpoch: number | undefined;
  constructor(
    private readonly client: MdbaseClient,
    declared: AppCollectionReadinessRequirements,
    source: AppCollectionReadinessBinding,
  ) {
    this.declared = requirements(declared);
    if (
      !uuid.test(source.collection) ||
      source.collection === "00000000-0000-0000-0000-000000000000" ||
      !uuid.test(source.generation)
    )
      throw error("fenced");
    this.binding = Object.freeze({
      collection: source.collection,
      generation: source.generation,
      signal: source.signal,
      isCurrent: source.isCurrent.bind(source),
    });
    this.readSignal = AbortSignal.any([
      this.binding.signal,
      this.lifetime.signal,
    ]);
    this.check();
    this.binding.signal.addEventListener("abort", this.abort, {
      once: true,
    });
  }
  private readonly abort = () => {
    void this.close();
  };
  getSnapshot(): AppCollectionReadinessSnapshot {
    if (this.snapshotValue.assessment) {
      try {
        this.check(undefined, this.assessedSession, this.assessedEpoch);
      } catch (original) {
        this.publish({
          checking: false,
          assessment: null,
          problem: problem(reasonOf(original)),
        });
      }
    }
    return this.snapshotValue;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(value: AppCollectionReadinessSnapshot): void {
    this.snapshotValue = Object.freeze(value);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observer cannot replace original READ disposition. */
      }
    }
  }
  private check(signal?: AbortSignal, session?: Session, epoch?: number): void {
    signal?.throwIfAborted();
    if (
      this.closed ||
      this.binding.signal.aborted ||
      this.binding.isCurrent() !== true
    )
      throw error("fenced");
    if (
      session &&
      (session.closed ||
        session !== this.client.currentSession() ||
        session.hello.collection !== this.binding.collection)
    )
      throw error("fenced");
    if (
      epoch !== undefined &&
      (epoch !== this.epoch || this.watch?.state !== "active")
    )
      throw error("changed");
  }
  private invalidate = (): void => {
    if (this.closed) return;
    this.epoch++;
    this.dirty = true;
    this.publish({ checking: true, assessment: null, problem: null });
    this.schedule();
  };
  private schedule(): void {
    if (
      this.closed ||
      this.pending ||
      this.scheduled ||
      !this.dirty ||
      this.watch?.state !== "active" ||
      this.client.link !== "open"
    )
      return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (
        !this.closed &&
        this.dirty &&
        !this.pending &&
        this.watch?.state === "active" &&
        this.client.link === "open"
      )
        void this.refresh().catch(() => {});
    });
  }
  private attach(): void {
    if (this.watch) return;
    this.watch = this.client.watchChanges(undefined, this.invalidate);
    this.stops.push(
      this.watch.subscribe(this.invalidate),
      this.client.onLink(this.invalidate),
      this.client.onStatus(() => {
        const next = statusStamp(this.client);
        if (next !== this.lastStatus) {
          this.lastStatus = next;
          this.invalidate();
        }
      }),
    );
  }
  start(signal?: AbortSignal): Promise<AppCollectionReadinessAssessment> {
    return this.refresh(signal);
  }
  refresh(caller?: AbortSignal): Promise<AppCollectionReadinessAssessment> {
    try {
      this.check(caller);
      if (this.pending) throw error("busy");
    } catch (value) {
      return Promise.reject(value);
    }
    const signal = AbortSignal.any([
      this.binding.signal,
      this.lifetime.signal,
      ...(caller ? [caller] : []),
    ]);
    let deliveredSession: Session | undefined,
      deliveredEpoch: number | undefined;
    const work = Promise.resolve()
      .then(async () => {
        this.check(signal);
        this.attach();
        const session = await this.client.readyForRead(signal);
        this.check(signal, session);
        await this.watch!.ready;
        this.check(signal, session);
        const epoch = this.epoch;
        this.dirty = false;
        this.check(signal, session, epoch);
        const before = await this.inventory(signal, session, epoch);
        // A caller abort fences delivery without cancelling/removing the
        // original Session.call waiter before its reply. Keep that READ occupied.
        const catalog = await this.client.describe(this.readSignal);
        this.check(signal, session, epoch);
        const evaluation = this.evaluate(catalog, session);
        for (const path of evaluation.paths) {
          const expected = before.find((row) => row.path === path);
          if (!expected) throw error("changed");
          const actual = await this.client.resources.get(path, this.readSignal);
          this.check(signal, session, epoch);
          if (
            actual.path !== expected.path ||
            actual.revision !== expected.revision ||
            actual.size !== expected.size ||
            actual.state !== "confirmed"
          )
            throw error("changed");
        }
        const after = await this.inventory(signal, session, epoch);
        if (JSON.stringify(before) !== JSON.stringify(after))
          throw error("changed");
        this.check(signal, session, epoch);
        const witness = Object.freeze({
          collection: this.binding.collection,
          generation: this.binding.generation,
          resources: Object.freeze(after),
        });
        const assessment = Object.freeze({
          status: evaluation.status,
          problem: evaluation.reason ? problem(evaluation.reason) : null,
          witness,
        });
        deliveredSession = session;
        deliveredEpoch = epoch;
        this.assessedSession = session;
        this.assessedEpoch = epoch;
        this.publish({
          checking: false,
          assessment,
          problem: assessment.problem,
        });
        this.check(signal, session, epoch); // Includes synchronous observer cuts.
        return assessment;
      })
      .catch((value) => {
        this.publish({
          checking: false,
          assessment: null,
          problem: problem(
            signal.aborted || this.closed ? "fenced" : reasonOf(value),
          ),
        });
        throw value; // Original rejection identity, never a diagnostic replacement.
      });
    // Reserve BEFORE callbacks so reentrant start/refresh cannot open another READ.
    this.pending = work;
    this.publish({ checking: true, assessment: null, problem: null });
    void work
      .finally(() => {
        if (this.pending === work) this.pending = null;
        this.schedule();
      })
      .catch(() => {});
    return work.then((value) => {
      try {
        this.check(signal, deliveredSession, deliveredEpoch);
        if (this.snapshotValue.assessment !== value) throw error("changed");
        return value;
      } catch (original) {
        if (this.snapshotValue.assessment === value)
          this.publish({
            checking: false,
            assessment: null,
            problem: problem(signal.aborted ? "fenced" : reasonOf(original)),
          });
        throw original;
      }
    });
  }
  private async inventory(
    signal: AbortSignal,
    session: Session,
    epoch: number,
  ): Promise<
    Array<Readonly<Pick<ResourceView, "path" | "revision" | "size" | "state">>>
  > {
    const rows: Array<
        Readonly<Pick<ResourceView, "path" | "revision" | "size" | "state">>
      > = [],
      seen = new Set<string>();
    let cursor: string | undefined,
      previous = "",
      bytes = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      this.check(signal, session, epoch);
      const result = await this.client.resources.list({
        text: false,
        limit: 128,
        ...(cursor ? { cursor } : {}),
        signal: this.readSignal,
      });
      this.check(signal, session, epoch);
      for (const row of result.resources) {
        if (
          !text(row.path) ||
          row.path <= previous ||
          !text(row.revision, 128) ||
          !Number.isSafeInteger(row.size) ||
          row.size < 0 ||
          row.state !== "confirmed"
        )
          throw error("catalog_response");
        previous = row.path;
        const copy = Object.freeze({
          path: row.path,
          revision: row.revision,
          size: row.size,
          state: row.state,
        });
        bytes += new TextEncoder().encode(JSON.stringify(copy)).length;
        if (rows.length >= MAX_RESOURCES || bytes > MAX_BYTES)
          throw error("budget");
        rows.push(copy);
      }
      if (result.complete === true && result.cursor === undefined) return rows;
      if (
        result.complete !== false ||
        !text(result.cursor) ||
        seen.has(result.cursor)
      )
        throw error("catalog_response");
      seen.add(result.cursor);
      cursor = result.cursor;
    }
    throw error("budget");
  }
  private evaluate(
    catalog: DescribeResult,
    session: Session,
  ): {
    status: AppCollectionReadinessAssessment["status"];
    reason?: AppCollectionReadinessReason;
    paths: string[];
  } {
    if (catalog.issues.some((issue) => issue.severity === "error"))
      return {
        status: "incompatible",
        reason: "catalog_invalid",
        paths: [],
      };
    if (
      this.declared.requiredNativeCapabilities.some(
        (cap) => !session.hello.grant.capabilities.includes(cap),
      )
    )
      return {
        status: "incompatible",
        reason: "capability_missing",
        paths: [],
      };
    const paths = new Set<string>(),
      contracts = new Set<string>(),
      types = new Set<string>();
    for (const row of catalog.contracts) {
      const key = JSON.stringify([row.id, row.version]);
      if (contracts.has(key))
        return {
          status: "incompatible",
          reason: "catalog_response",
          paths: [],
        };
      contracts.add(key);
    }
    for (const row of catalog.types) {
      if (types.has(row.name))
        return {
          status: "incompatible",
          reason: "catalog_response",
          paths: [],
        };
      types.add(row.name);
    }
    let setupReason: AppCollectionReadinessReason | undefined;
    for (const required of this.declared.contracts) {
      const contract = catalog.contracts.find(
        (row) => row.id === required.id && row.version === required.version,
      );
      if (!contract) {
        setupReason ??= "contract_missing";
        continue;
      }
      if (contract.digest !== required.digest)
        return {
          status: "incompatible",
          reason: "contract_mismatch",
          paths: [],
        };
      paths.add(contract.path);
      if (!contract.implementedBy.length) {
        setupReason ??= "implementation_missing";
        continue;
      }
      for (const name of contract.implementedBy) {
        const type = catalog.types.find((row) => row.name === name);
        if (
          !type ||
          !type.implements.some(
            (row) =>
              row.contract === required.id && row.version === required.version,
          )
        )
          return {
            status: "incompatible",
            reason: "catalog_response",
            paths: [],
          };
        paths.add(type.path);
      }
    }
    return {
      status: setupReason ? "setup_required" : "ready",
      ...(setupReason ? { reason: setupReason } : {}),
      paths: [...paths].sort(),
    };
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.dirty = false;
      this.lifetime.abort();
      this.binding.signal.removeEventListener("abort", this.abort);
      for (const stop of this.stops.splice(0)) stop();
      this.watch?.();
      this.watch = null;
      this.publish({
        checking: false,
        assessment: null,
        problem: problem("fenced"),
      });
    }
    await this.pending?.catch(() => {});
  }
}
export function createAppCollectionReadiness(
  client: MdbaseClient,
  declared: AppCollectionReadinessRequirements,
  binding: AppCollectionReadinessBinding,
): AppCollectionReadiness {
  return new AppCollectionReadiness(client, declared, binding);
}
