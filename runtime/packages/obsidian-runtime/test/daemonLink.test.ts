import { describe, expect, it } from "vitest";
import { daemonStateDir, findDaemon, firstPayload, type LinkFs } from "../src/daemon/link.js";
import { handOff, reconcileHandoff, hostingDecision, type HandoffChannel, type HandoffHost, type HandoffIntent, type HandoffState, type PendingMutation } from "../src/daemon/handoff.js";

const DIR = "/home/u/.local/state/mdbase";
const TOKEN = "ab".repeat(32);
const NOISE = "cd".repeat(32);
const DEV = "11111111-2222-4333-8444-555555555555";

function fakeFs(over: Partial<Record<string, { uid?: number; mode?: number; symlink?: boolean; body?: string; dir?: boolean }>> = {}): LinkFs {
  const files: Record<string, { uid?: number; mode?: number; symlink?: boolean; body?: string; dir?: boolean }> = {
    [DIR]: { dir: true, mode: 0o700 },
    [`${DIR}/local-link.json`]: { body: JSON.stringify({ port: 47123, token: TOKEN }), mode: 0o600 },
    [`${DIR}/daemon.json`]: { body: JSON.stringify({ schema_version: 1, device: DEV, noise_pk: NOISE, sign_pk: NOISE, kem_pk: NOISE }), mode: 0o600 },
    ...over,
  };
  const get = (p: string) => {
    const f = files[p];
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return f;
  };
  return {
    async lstat(p) {
      const f = get(p);
      return { isSymbolicLink: () => !!f.symlink, isFile: () => !f.dir && !f.symlink, isDirectory: () => !!f.dir, uid: f.uid ?? 1000, mode: f.mode ?? 0o600 };
    },
    async readFile(p) {
      return get(p).body ?? "";
    },
  };
}

describe("daemon link discovery (§12.4)", () => {
  it("state dirs match crates/daemon paths.rs", () => {
    expect(daemonStateDir("linux", { HOME: "/home/u" })).toBe(DIR);
    expect(daemonStateDir("darwin", { HOME: "/Users/u" })).toBe("/Users/u/Library/Application Support/mdbase");
    expect(daemonStateDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe("C:\\Users\\u\\AppData\\Local\\mdbase\\state");
    expect(daemonStateDir("android", {})).toBeNull();
  });
  it("reads a well-formed, owner-only link", async () => {
    const r = await findDaemon(fakeFs(), DIR, 1000);
    expect("link" in r && r.link.url).toBe("ws://127.0.0.1:47123/v1/plugin");
    expect("link" in r && r.link.device).toBe(DEV);
  });
  it("refuses insecure or malformed state; absent is absent", async () => {
    expect(await findDaemon(fakeFs({ [`${DIR}/local-link.json`]: { body: "{}", mode: 0o666 } }), DIR, 1000)).toEqual({ problem: "insecure" });
    expect(await findDaemon(fakeFs({ [`${DIR}/daemon.json`]: { symlink: true } }), DIR, 1000)).toEqual({ problem: "insecure" });
    expect(await findDaemon(fakeFs(), DIR, 1001)).toEqual({ problem: "insecure" });
    expect(await findDaemon(fakeFs({ [`${DIR}/local-link.json`]: { body: JSON.stringify({ port: 99999, token: TOKEN }) } }), DIR, 1000)).toEqual({ problem: "malformed" });
    expect(await findDaemon(fakeFs({ [`${DIR}/local-link.json`]: undefined }), DIR, 1000)).toEqual({ problem: "absent" });
    expect(await findDaemon(fakeFs(), null, 1000)).toEqual({ problem: "absent" });
  });
  it("first payload is canonical {0: token, 1: hello-params}", () => {
    const p = firstPayload(new Uint8Array(32).fill(7), Uint8Array.of(0xa0));
    expect(Buffer.from(p).toString("hex")).toBe("a2005820" + "07".repeat(32) + "01a0");
  });
});

class Host implements HandoffHost {
  log: string[] = [];
  journal: PendingMutation[];
  marker: string | null = null;
  intent: HandoffIntent | null = null;
  persistFails = false;
  finalMarkerFails = false;
  partialPersistFails = false;
  finalIntent: HandoffIntent | null = null;
  private lockTail: Promise<void> = Promise.resolve();
  async withHandoffLock<T>(_collection: string, run: () => Promise<T>): Promise<T> {
    const result = this.lockTail.then(run);
    this.lockTail = result.then(() => {}, () => {});
    return result;
  }
  constructor(n: number) {
    this.journal = Array.from({ length: n }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), bytes: Uint8Array.of(i & 0xff) }));
  }
  async quiesce() { this.log.push("quiesce"); }
  async resume() { this.log.push("resume"); }
  async pending() { return [...this.journal]; }
  async dropPending(ids: readonly string[]) { this.journal = this.journal.filter((m) => !ids.includes(m.id)); }
  async journalHead() { return 42; }
  async handoffState(): Promise<HandoffState> {
    if (this.finalIntent) return { kind: "handed_off", intent: { ...this.finalIntent } };
    return this.intent ? { kind: "pending", intent: { ...this.intent } } : { kind: "host" };
  }
  async compareHandoffState(expected: HandoffState, next: HandoffState): Promise<boolean> {
    if (JSON.stringify(await this.handoffState()) !== JSON.stringify(expected)) return false;
    if (next.kind === "pending") {
      if (this.persistFails) throw new Error("journal unavailable");
      this.intent = { ...next.intent }; // mock durable state, carried into restart fixtures
      this.log.push("fence");
      if (this.partialPersistFails) throw new Error("intent persisted, reply lost");
    } else if (next.kind === "host") {
      this.intent = null;
      this.log.push("unfence");
    } else {
      if (this.finalMarkerFails) throw new Error("marker flush failed");
      this.marker = next.intent.daemonDevice;
      this.finalIntent = { ...next.intent };
      this.intent = null;
    }
    return true;
  }
  async becomeClient() { this.log.push("client"); }
  notices: string[] = [];
  enrol: { account: string; kind: string } | null = { account: "acct-1", kind: "desktop" };
  async enrolmentOf() { return this.enrol; }
  ownAccount() { return "acct-1"; }
  notify(m: string) { this.notices.push(m); }
  approveFails = false;
  retireFails = false;
  async approveDaemon(d: string) {
    if (this.approveFails) throw new Error("codes differ");
    this.log.push(`approve ${d}`);
  }
  async retireSelf() {
    if (this.retireFails) throw new Error("offline");
    this.log.push("retire");
  }
}

interface DaemonState { id: string | null; status: "hosting" | "aborted" | "unknown" }
function daemon(opts: { refuse?: boolean; failAfterBatches?: number; notHosting?: boolean; loseReadyAck?: boolean; state?: DaemonState } = {}) {
  const held = new Set<string>();
  const state = opts.state ?? { id: null, status: "unknown" as const };
  let batches = 0;
  let readyCalls = 0;
  const ch: HandoffChannel = {
    peer: { device: DEV, noisePk: NOISE },
    async request(method: string, p: any): Promise<any> {
      if (method === "handoff_offer") return opts.refuse ? { accept: false, reason: "busy" } : { accept: true, daemon_device: DEV };
      if (method === "handoff_pending") {
        if (opts.failAfterBatches !== undefined && batches >= opts.failAfterBatches) throw new Error("link dropped");
        batches++;
        for (const m of p.mutations) held.add(m.id); // durable enqueue, idempotent by ID
        return { held: p.mutations.map((m: PendingMutation) => m.id) };
      }
      if (method === "handoff_ready") {
        readyCalls++;
        state.id = p.handoff_id;
        const hosting = !opts.notHosting && state.status !== "aborted";
        if (hosting) state.status = "hosting";
        if (opts.loseReadyAck) throw new Error("hosting committed, reply lost");
        return { handoff_id: p.handoff_id, daemon_device: DEV, hosting, reason: hosting ? undefined : "adopt failed" };
      }
      if (method === "handoff_status") return { handoff_id: state.id ?? p.handoff_id, daemon_device: DEV, status: state.status };
      throw new Error(method);
    },
  } as HandoffChannel;
  return { ch, held, state, readyCalls: () => readyCalls };
}
const me = { collection: "c", sem: { major: 1, minor: 0 }, runtimeVersion: "1.0.0", synced: true };

describe("handoff (§13 rule 3)", () => {
  it("moves every pending mutation, records the marker, becomes a client", async () => {
    const h = new Host(450);
    const d = daemon();
    expect(await handOff(h, d.ch, me)).toEqual({ kind: "handed_off", moved: 450, retired: true });
    expect(d.held.size).toBe(450);
    expect(h.journal).toEqual([]);
    expect(h.marker).toBe(DEV);
    // Q36: approve the daemon's new device first, retire our own device last.
    expect(h.log).toEqual([`approve ${DEV}`, "quiesce", "fence", "client", "retire"]);
  });
  it("refuses a daemon enrolled on another account or as the wrong kind", async () => {
    for (const [enrol, reason] of [
      [{ account: "acct-2", kind: "desktop" }, "daemon_other_account"],
      [{ account: "acct-1", kind: "mobile" }, "daemon_wrong_kind"],
      [null, "daemon_not_enrolled"],
    ] as const) {
      const h = new Host(2);
      h.enrol = enrol;
      expect(await handOff(h, daemon().ch, me)).toEqual({ kind: "refused", reason, resumed: true });
      expect(h.log).toEqual([]);
    }
    const cli = new Host(0);
    cli.enrol = { account: "ACCT-1", kind: "cli" };
    expect((await handOff(cli, daemon().ch, me)).kind).toBe("handed_off");
  });
  it("shows a local notice when the handoff completes", async () => {
    const h = new Host(1);
    await handOff(h, daemon().ch, me);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/review your devices/);
  });
  it("if approving the daemon's device fails, nothing moves and hosting stays here", async () => {
    const h = new Host(5);
    h.approveFails = true;
    const d = daemon();
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "refused", resumed: true });
    expect(d.held.size).toBe(0);
    expect(h.log).toEqual([]);
  });
  it("a failed retire is reported but never brings hosting back", async () => {
    const h = new Host(1);
    h.retireFails = true;
    expect(await handOff(h, daemon().ch, me)).toMatchObject({ kind: "handed_off", retired: false });
    expect(h.log).not.toContain("resume");
  });
  it("a refusal keeps hosting without quiescing", async () => {
    const h = new Host(3);
    expect(await handOff(h, daemon({ refuse: true }).ch, me)).toMatchObject({ kind: "refused", resumed: true });
    expect(h.log).toEqual([]);
  });
  it("an interruption loses and duplicates nothing; a retry completes", async () => {
    const h = new Host(450);
    const d1 = daemon({ failAfterBatches: 1 });
    expect(await handOff(h, d1.ch, me)).toMatchObject({ kind: "failed", resumed: true });
    expect(h.journal.length + d1.held.size).toBe(450);
    expect(h.marker).toBeNull();
    // Retry with the same daemon state: re-offers are deduplicated by ID.
    const d2 = daemon();
    for (const id of d1.held) d2.held.add(id);
    expect(await handOff(h, d2.ch, me)).toMatchObject({ kind: "handed_off" });
    expect(d2.held.size).toBe(450);
  });
  it("a negative ready reply is not terminal proof and leaves hosting fenced", async () => {
    const h = new Host(1);
    expect(await handOff(h, daemon({ notHosting: true }).ch, me)).toMatchObject({ kind: "failed", resumed: false });
    expect(h.log).not.toContain("resume");
    expect(h.intent?.daemonDevice).toBe(DEV);
  });
  it("never sends ready before the durable intent is recorded", async () => {
    const h = new Host(1);
    h.persistFails = true;
    const d = daemon();
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "failed", resumed: true });
    expect(d.readyCalls()).toBe(0);
    expect(d.state.status).toBe("unknown");
    expect(h.log).toContain("resume");
  });
  it("a lost ready ACK never resumes, and restart reconciles the exact durable identity", async () => {
    const h = new Host(2);
    const d = daemon({ loseReadyAck: true });
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "failed", resumed: false });
    expect(d.state.status).toBe("hosting");
    expect(h.intent?.id).toBe(d.state.id);
    expect(h.log).not.toContain("resume");
    expect(h.marker).toBeNull();
    // New plugin process: only the durable intent survives, not an in-memory ACK.
    const restarted = new Host(0);
    restarted.intent = structuredClone(h.intent);
    const reconnected = daemon({ state: d.state });
    expect(await handOff(restarted, reconnected.ch, me)).toMatchObject({ kind: "handed_off", retired: true });
    expect(reconnected.readyCalls()).toBe(0); // status, never a new offer/ready
    expect(restarted.marker).toBe(DEV);
    expect(restarted.intent).toBeNull();
    expect(restarted.log).toEqual(["client", "retire"]);
  });
  it("an unknown or unreachable status never clears the fence", async () => {
    const h = new Host(0);
    const d = daemon({ notHosting: true });
    await handOff(h, d.ch, me);
    const before = structuredClone(h.intent);
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "failed", resumed: false });
    const unreachable = { peer: d.ch.peer, request: async () => { throw new Error("offline"); } } as HandoffChannel;
    expect(await handOff(h, unreachable, me)).toMatchObject({ kind: "failed", resumed: false });
    expect(h.intent).toEqual(before);
    expect(h.log).not.toContain("resume");
  });
  it("only an identity-bound terminal abort permits resume; late ready cannot activate it", async () => {
    const h = new Host(0);
    const d = daemon({ notHosting: true });
    await handOff(h, d.ch, me);
    const id = h.intent!.id;
    d.state.status = "aborted"; // durable terminal transition, not merely not-running
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "failed", resumed: true });
    expect(h.intent).toBeNull();
    expect(h.log.slice(-2)).toEqual(["unfence", "resume"]);
    const late = await daemon({ state: d.state }).ch.request("handoff_ready", { collection: me.collection, handoff_id: id, journal_head: 42 });
    expect(late.hosting).toBe(false);
    expect(d.state.status).toBe("aborted");
  });
  it("different handoff or daemon identities cannot release the fence", async () => {
    for (const mismatch of ["id", "device"] as const) {
      const h = new Host(0);
      await handOff(h, daemon({ notHosting: true }).ch, me);
      const before = structuredClone(h.intent);
      const wrong = { peer: { device: DEV, noisePk: NOISE }, request: async () => ({ handoff_id: mismatch === "id" ? "other" : before!.id, daemon_device: mismatch === "device" ? "other" : DEV, status: "aborted" }) } as unknown as HandoffChannel;
      expect(await handOff(h, wrong, me)).toMatchObject({ kind: "failed", resumed: false });
      expect(h.intent).toEqual(before);
      expect(h.log).not.toContain("resume");
    }
  });
  it("a changed channel pin cannot reconcile even a matching device/id response", async () => {
    const h = new Host(0);
    await handOff(h, daemon({ notHosting: true }).ch, me);
    const before = structuredClone(h.intent);
    let requested = false;
    const changed = {
      peer: { device: DEV, noisePk: "different pin" },
      request: async () => { requested = true; throw new Error("must not query changed identity"); },
    } as HandoffChannel;
    expect(await handOff(h, changed, me)).toMatchObject({ kind: "failed", resumed: false });
    expect(requested).toBe(false);
    expect(h.intent).toEqual(before);
    expect(h.log).not.toContain("resume");
  });
  it("a crash-window final-marker failure retains the intent for restart reconciliation", async () => {
    const h = new Host(0);
    h.finalMarkerFails = true;
    const d = daemon();
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "failed", resumed: false });
    expect(h.intent?.id).toBe(d.state.id);
    expect(h.log).not.toContain("resume");
    const restarted = new Host(0);
    restarted.intent = structuredClone(h.intent);
    expect(await handOff(restarted, d.ch, me)).toMatchObject({ kind: "handed_off" });
    expect(restarted.marker).toBe(DEV);
  });
  it.each([false, true])("concurrent lost-ACK handoffs keep one identity (distinct wrapper=%s)", async (distinct) => {
    const h = new Host(0);
    // Distinct facade, SAME device/collection backend lock and durable state.
    const other = distinct ? new Proxy(h, {
      get(target, key) { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; },
    }) : h;
    let releaseReady!: () => void;
    let readyEntered!: () => void;
    const gate = new Promise<void>(r => { releaseReady = r; });
    const entered = new Promise<void>(r => { readyEntered = r; });
    const d = daemon({ loseReadyAck: true });
    const request = d.ch.request.bind(d.ch);
    d.ch.request = (async (method: any, params: any) => {
      if (method === "handoff_ready") { readyEntered(); await gate; }
      return request(method, params);
    }) as HandoffChannel["request"];
    const first = handOff(h, d.ch, me);
    const second = handOff(other, d.ch, me);
    await entered;
    const firstId = h.intent!.id;
    releaseReady();
    expect(await first).toMatchObject({ kind: "failed", resumed: false });
    expect(await second).toMatchObject({ kind: "handed_off" });
    expect(d.readyCalls()).toBe(1);
    expect(d.state.id).toBe(firstId);
    expect(h.finalIntent?.id).toBe(firstId);
    expect(h.log.filter(v => v === "quiesce")).toHaveLength(1);
    expect(h.log).not.toContain("resume");
    // Final state also prevents a third/restarted caller from making a new ID.
    const restarted = new Host(0);
    restarted.finalIntent = structuredClone(h.finalIntent);
    expect(await handOff(restarted, d.ch, me)).toMatchObject({ kind: "handed_off" });
    expect(d.readyCalls()).toBe(1);
    expect(restarted.log).not.toContain("resume");
  });
  it("durable CAS rejects overwriting a pending or completed fence", async () => {
    const h = new Host(0);
    const a: HandoffIntent = { id: "first", daemonDevice: DEV, daemonNoisePk: NOISE };
    const b = { ...a, id: "second" };
    expect(await h.compareHandoffState({ kind: "host" }, { kind: "pending", intent: a })).toBe(true);
    expect(await h.compareHandoffState({ kind: "host" }, { kind: "pending", intent: b })).toBe(false);
    expect(await h.compareHandoffState({ kind: "pending", intent: b }, { kind: "host" })).toBe(false);
    expect(h.intent).toEqual(a);
    expect(await h.compareHandoffState({ kind: "pending", intent: a }, { kind: "handed_off", intent: a })).toBe(true);
    expect(await h.compareHandoffState({ kind: "host" }, { kind: "pending", intent: b })).toBe(false);
    expect(h.finalIntent).toEqual(a);
  });
  it("uncertain CAS persistence never sends ready or resumes", async () => {
    const h = new Host(0);
    h.partialPersistFails = true;
    const d = daemon();
    expect(await handOff(h, d.ch, me)).toMatchObject({ kind: "failed", resumed: false });
    expect(h.intent).not.toBeNull();
    expect(d.readyCalls()).toBe(0);
    expect(h.log).not.toContain("resume");
  });
  it("stale reconciliation cannot clear a newer intent or completed marker", async () => {
    for (const final of [false, true]) {
      const h = new Host(0);
      const stale: HandoffIntent = { id: "old", daemonDevice: DEV, daemonNoisePk: NOISE };
      const current = { ...stale, id: "current" };
      if (final) h.finalIntent = current; else h.intent = current;
      let queried = false;
      const ch = { peer: { device: DEV, noisePk: NOISE }, request: async () => {
        queried = true;
        return { handoff_id: stale.id, daemon_device: DEV, status: "aborted" };
      } } as unknown as HandoffChannel;
      expect(await reconcileHandoff(h, ch, me, stale)).toMatchObject({ kind: "failed", resumed: false });
      expect(queried).toBe(false);
      expect((await h.handoffState()).kind).toBe(final ? "handed_off" : "pending");
      expect(h.log).not.toContain("resume");
    }
  });
  it("terminal-abort resume remains locked against a new handoff", async () => {
    const h = new Host(0);
    const d = daemon({ notHosting: true });
    await handOff(h, d.ch, me);
    const intent = structuredClone(h.intent!);
    d.state.status = "aborted";
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const resumed = new Promise<void>(r => { entered = r; });
    h.resume = async () => { entered(); await gate; h.log.push("resume"); };
    const first = reconcileHandoff(h, d.ch, me, intent);
    await resumed;
    let offers = 0;
    const request = d.ch.request.bind(d.ch);
    d.ch.request = (async (method: any, params: any) => { if (method === "handoff_offer") offers++; return request(method, params); }) as HandoffChannel["request"];
    const next = handOff(h, d.ch, me);
    await new Promise(r => setTimeout(r, 0));
    expect(offers).toBe(0);
    release();
    expect(await first).toMatchObject({ resumed: true });
    await next;
    expect(offers).toBe(1);
  });
  it("start-up decision never makes two hosts", () => {
    expect(hostingDecision({ daemonReachable: false, handedOffTo: DEV, mobile: false })).toBe("wait_for_daemon");
    expect(hostingDecision({ daemonReachable: true, handedOffTo: DEV, mobile: false })).toBe("attach_to_daemon");
    expect(hostingDecision({ daemonReachable: true, handedOffTo: null, mobile: false })).toBe("offer_handoff");
    expect(hostingDecision({ daemonReachable: false, handedOffTo: null, mobile: false })).toBe("host");
    expect(hostingDecision({ daemonReachable: false, handedOffTo: null, mobile: true })).toBe("host");
    expect(hostingDecision({ daemonReachable: false, handedOffTo: null, pendingHandoffTo: DEV, mobile: false })).toBe("wait_for_daemon");
    expect(hostingDecision({ daemonReachable: true, handedOffTo: null, pendingHandoffTo: DEV, mobile: false })).toBe("reconcile_handoff");
    expect(hostingDecision({ daemonReachable: false, handedOffTo: null, pendingHandoffTo: DEV, mobile: true })).toBe("wait_for_daemon");
  });
});
