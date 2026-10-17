// A ledger-faithful fake of the native migration Driver for executor tests.
// Mirrors the native contract the executor relies on:
// - one saved action at a time; prepare refuses while one is unsettled;
// - tickets are instance-bound (RAM): a new instance over the same saved
//   state cannot settle the old action, so it stays UNKNOWN;
// - settlement and checkpoint update are one write, confirmed by sync;
// - log appends and their sent batch live in RAM only.
// The durable state goes through `NativeStore` (DO SQLite in workerd, a Map in
// Node); `effect` reaches the outside world (log append) and `boundary` lets a
// harness kill the process at a named point.
import { IDLE, SettlementRefused, type MigrationHost, type Prepared } from "../../src/migration-executor.ts";
import { STEP, type NativeState } from "../../src/migration-run.ts";
import type { MigrationPendingTicket } from "../../src/engine.ts";
import type { CborValue } from "../../../../packages/sdk/src/cbor.ts";
import type { Gen0Placement } from "../../src/migration-gen0-input.ts";

export type Settle = "provider" | "rollback" | "log" | "source" | "gen0" | "created" | "none";
export interface PlanStep {
  kind: number;
  fields?: CborValue[];
  /** Checkpoint step after this action settles. */
  step: number;
  settle: Settle;
  /** Provider result kind the settlement must carry. */
  provider?: string;
  /** One-shot idle reasons returned by prepare before this action (e.g. "not yet"). */
  idleBefore?: number[];
  placements?: Gen0Placement[];
  done?: boolean;
}

export interface Saved {
  index: number;
  seq: number;
  step: number;
  attempts: number;
  baseSeq: number | null;
  revoked: string[];
  outstanding: { seq: number; kind: number } | null;
  idleUsed: number;
  fenced?: boolean;
}

export interface NativeStore {
  read(): Saved | null;
  write(s: Saved): void;
  sync(): Promise<void>;
}

export function mapStore(): NativeStore & { saved: Saved | null; syncs: number } {
  const store = {
    saved: null as Saved | null, syncs: 0,
    read: () => store.saved && structuredClone(store.saved),
    write: (s: Saved) => { store.saved = structuredClone(s); },
    sync: async () => { store.syncs++; },
  };
  return store;
}

export interface FakeHooks {
  boundary?: (name: string, kind: number) => Promise<void>;
  /** The log append (an external effect); resolves when acknowledged. */
  effect?: (name: string, kind: number) => Promise<void>;
}

export class FakeNative implements MigrationHost {
  readonly calls: string[] = [];
  /** Kinds of the outstanding action at each head-fetching pump. */
  readonly heads: number[] = [];
  readonly results: Array<{ kind: number; result: unknown }> = [];
  resets = 0;
  owner = "7a3f1c52-9a1e-4c7e-8d6b-2f0e1a9b3c4d";
  /** Next settlement attempts refused once, by kind (native "not yet"). */
  refuseOnce = new Set<number>();
  readonly #live = new WeakSet<MigrationPendingTicket>();
  readonly #sealed = new WeakSet<MigrationPendingTicket>();
  #sent: { seq: number; kind: number; acked: boolean } | null = null;

  constructor(readonly plan: PlanStep[], readonly store: NativeStore, readonly hooks: FakeHooks = {},
    readonly collection = "0b6b7f4e-3c1d-4e2a-9f8b-5a6c7d8e9f01") {}

  #saved(): Saved {
    return this.store.read() ?? { index: 0, seq: 0, step: STEP.start, attempts: 0, baseSeq: null, revoked: [], outstanding: null, idleUsed: 0 };
  }

  state(): NativeState {
    const s = this.store.read();
    if (!s) return { runSequence: null, checkpoint: null, outstanding: null };
    return {
      runSequence: 1,
      checkpoint: { step: s.step, fenced: s.fenced === true, fenceFirst: true, sFinal: 40, baseSeq: s.baseSeq,
        cutoverSeq: null, revoked: s.revoked, attempts: s.attempts, failure: null },
      outstanding: s.outstanding,
    };
  }

  claim() { return { owner_account: this.owner, started_us: "10413792000000001" }; }

  async prepare(_signal: AbortSignal): Promise<Prepared> {
    const s = this.#saved();
    if (s.outstanding) throw new Error("migration_outstanding_unknown");
    const plan = this.plan[s.index];
    if (!plan) return { idle: IDLE.done };
    if (plan.idleBefore && s.idleUsed < plan.idleBefore.length) {
      const idle = plan.idleBefore[s.idleUsed++]!;
      this.store.write(s);
      await this.store.sync();
      return { idle };
    }
    s.seq++;
    s.outstanding = { seq: s.seq, kind: plan.kind };
    this.store.write(s);
    await this.store.sync();
    const ticket: MigrationPendingTicket = { collection: this.collection, driver: "d".repeat(32), action: s.seq.toString(16).padStart(64, "0"),
      sequence: s.seq, kind: plan.kind, fingerprint: "f".repeat(64) };
    this.#live.add(ticket);
    this.calls.push(`prepare:${plan.kind}`);
    await this.hooks.boundary?.("prepared", plan.kind);
    return { ticket, fields: [plan.kind, ...(plan.fields ?? [])] };
  }

  async #settle(t: MigrationPendingTicket, how: Settle, result: unknown): Promise<string> {
    const s = this.#saved(), plan = this.plan[s.index];
    if (!this.#live.has(t) || !s.outstanding || s.outstanding.seq !== t.sequence || !plan || plan.settle !== how) {
      throw new SettlementRefused("migration_settlement_refused");
    }
    if (this.refuseOnce.delete(t.kind)) throw new SettlementRefused("migration_settlement_not_yet");
    if (how === "provider" && plan.provider && (result as { kind?: string }).kind !== plan.provider) {
      throw new SettlementRefused("migration_provider_result_mismatch");
    }
    this.#live.delete(t);
    s.outstanding = null;
    s.index++;
    s.idleUsed = 0;
    s.step = plan.step;
    if (t.kind === 6) s.baseSeq = 21;
    if (t.kind === 11) s.fenced = true;
    if (t.kind === 14) s.revoked = ["r1"];
    if (t.kind === 20) s.revoked = [];
    if (t.kind === 21) s.fenced = false;
    this.store.write(s);
    this.results.push({ kind: t.kind, result });
    await this.hooks.boundary?.("written", t.kind);
    await this.store.sync();
    await this.hooks.boundary?.("settled", t.kind);
    return "a".repeat(64);
  }

  keyingWait(t: MigrationPendingTicket) { return this.#settle(t, "created", "keying"); }
  targetCreated(t: MigrationPendingTicket) { return this.#settle(t, "created", "created"); }
  provider(t: MigrationPendingTicket, result: unknown) { return this.#settle(t, "provider", result); }
  rollbackScope(t: MigrationPendingTicket) {
    if (!this.#live.has(t)) throw new SettlementRefused("migration_pending_refused");
    return { providerMigrationId: "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a", fixedHead: 40,
      driverId: "11111111-1111-4111-8111-111111111111", actionId: "22222222-2222-4222-8222-222222222222",
      replicaIds: ["33333333-3333-4333-8333-333333333333"], authorityEpoch: t.kind === 20 ? null : 17, original: t.kind === 21 };
  }
  rollbackResult(t: MigrationPendingTicket, body: unknown) { return this.#settle(t, "rollback", body); }
  source(t: MigrationPendingTicket, result: unknown) { return this.#settle(t, "source", result); }
  gen0Placements(t: MigrationPendingTicket) {
    if (!this.#live.has(t) || this.#sealed.has(t)) throw new Error("migration_gen0_refused");
    const plan = this.plan[this.#saved().index]!;
    return { rows: plan.placements ?? [], done: plan.done ?? true };
  }
  gen0FileChunk(_t: MigrationPendingTicket, input: { file: { fileId: string }; offset: number; bytes: Uint8Array }) {
    this.calls.push(`gen0FileChunk:${input.file.fileId}:${input.offset}:${input.bytes.length}`);
    return { objects: [{ address: "1".repeat(64), kind: 1, bytes: input.bytes.slice() }], verify: [] };
  }
  gen0Window(t: MigrationPendingTicket, input: { rows: unknown[] }) {
    if (this.#sealed.has(t)) throw new Error("migration_gen0_refused");
    this.#sealed.add(t);
    this.calls.push(`gen0Window:${input.rows.length}`);
    return { objects: [{ address: "2".repeat(64), kind: 2, bytes: new Uint8Array([1]) }], verify: ["2".repeat(64)] };
  }
  gen0Finish() { return { objects: [], verify: ["2".repeat(64)] }; }
  gen0Result(t: MigrationPendingTicket, result: { present: boolean[] }) {
    if (!result.present.every(Boolean)) return Promise.reject(new SettlementRefused("migration_gen0_missing"));
    return this.#settle(t, "gen0", result);
  }
  logAppend(t: MigrationPendingTicket) {
    if (!this.#live.has(t) || this.#sent?.seq === t.sequence) throw new Error("migration_log_append_refused");
    this.#sent = { seq: t.sequence, kind: t.kind, acked: false };
    return { item: "c".repeat(64), seq: 21 };
  }
  async logResult(t: MigrationPendingTicket) {
    if (t.kind === 6 && !(this.#sent?.seq === t.sequence && this.#sent.acked)) throw new SettlementRefused("migration_log_not_yet");
    return this.#settle(t, "log", "log");
  }
  release(t: MigrationPendingTicket) { this.#live.delete(t); this.calls.push(`release:${t.kind}`); }
  async pump(_signal?: AbortSignal, head?: boolean) {
    if (head) this.heads.push(this.#saved().outstanding?.kind ?? -1);
    const sent = this.#sent;
    if (sent && !sent.acked) {
      await this.hooks.effect?.("log-append", sent.kind);
      sent.acked = true;
    }
  }
  async resetForRebuild() { this.resets++; }
  async putObject(_c: string, o: { address: string; kind: number }) {
    const kind = this.#saved().outstanding?.kind ?? 0;
    await this.hooks.boundary?.("sealed", kind);
    this.calls.push(`put:${o.address.slice(0, 1)}`);
    await this.hooks.effect?.(o.kind === 1 ? "file-put" : "window-put", kind);
    await this.hooks.boundary?.("uploaded", kind);
  }
  async hasObjects(_c: string, a: string[]) { return a.map(() => true); }
}

const UUID_HOLD = "5e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b";
export const HOLD = UUID_HOLD;

/** The fence-first Driver order over provider and log actions (reads and
 * the shadow compare elided): fence and drain first, then the base append. */
export function providerPlan(): PlanStep[] {
  return [
    { kind: 0, step: STEP.backupHeld, settle: "provider", provider: "backup" },
    { kind: 1, step: STEP.created, settle: "created" },
    { kind: 10, step: STEP.created, settle: "provider", provider: "account", idleBefore: [IDLE.waitPaused] },
    { kind: 11, step: STEP.created, settle: "provider", provider: "fence" },
    { kind: 12, step: STEP.created, settle: "provider", provider: "drain", idleBefore: [IDLE.waitDraining] },
    { kind: 6, step: STEP.baseAppended, settle: "log" },
    { kind: 13, step: STEP.verified, settle: "provider", provider: "replicas" },
    { kind: 14, fields: [["r1"]], step: STEP.revoked, settle: "provider", provider: "revoked" },
    { kind: 15, step: STEP.replayed, settle: "log" },
    { kind: 8, step: STEP.replayed, settle: "log" },
    { kind: 19, fields: [40, 22, 23, new Uint8Array(32).fill(9)], step: STEP.routed, settle: "provider", provider: "cutover" },
  ];
}
