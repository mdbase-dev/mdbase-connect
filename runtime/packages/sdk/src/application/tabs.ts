/** One session per app per browser. The first tab (the leader) runs the SDK
 * Worker; every other tab of the same app and build (a follower) attaches to
 * that Worker through the leader page. Followers get their own operation
 * channel and their own data, control and timer ports, so reads, writes and
 * live updates work in every tab, and sign-out, revocation and collection
 * switches reach all of them through the one session.
 *
 * Leadership is a Web Lock. Followers wait for it; when the leader tab closes,
 * reloads or is parked in the back/forward cache, the next follower takes over
 * and the others re-attach. BroadcastChannel cannot transfer MessagePorts, so
 * the leader page tunnels each port as a numbered stream: any port inside a
 * message becomes a stream marker on one side and a fresh local port on the
 * other. Each follower holds a presence lock; the leader waits on it, so a tab
 * that vanishes without a goodbye is detached all the same. No timers. */

const PROTOCOL = "mdbn-app-tabs/1";
const MARK = "\u0000mdbn-port";
const MAX_DEPTH = 6;

export interface ApplicationTabsScope {
  readonly cpOrigin: string;
  readonly appId: string;
  /** Build identity (the Worker module URL): tabs on different builds never share a Worker. */
  readonly build: string;
  readonly storageNamespace?: string;
}
export interface ApplicationTabLocks {
  request(name: string, options: {ifAvailable: true; signal?: undefined}, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  request(name: string, options: {signal?: AbortSignal}, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}
export interface ApplicationTabsEnvironment {
  readonly locks: ApplicationTabLocks;
  readonly BroadcastChannel: typeof globalThis.BroadcastChannel;
}
/** A follower's link to the leader's Worker. */
export interface ApplicationFollowerLink {
  readonly port: MessagePort;
  readonly binding: string;
  /** Leave the leader (this tab's runtime stopped). */
  leave(): void;
}
export interface ApplicationLeaderWorker {
  attach(port: MessagePort, binding: string): void;
  detach(binding: string): void;
}
type Message =
  | {readonly k: "join"; readonly tab: string}
  | {readonly k: "joined"; readonly tab: string; readonly binding: string; readonly leader: string}
  | {readonly k: "leader"; readonly leader: string}
  | {readonly k: "bye"; readonly leader: string; readonly signedOut?: true}
  | {readonly k: "fault"; readonly leader: string}
  | {readonly k: "signedOut"; readonly leader: string}
  | {readonly k: "signedIn"; readonly leader: string}
  | {readonly k: "leave"; readonly tab: string}
  | {readonly k: "m"; readonly tab: string; readonly up: boolean; readonly s: number; readonly d: unknown};

const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
function message(value: unknown): Message | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  switch (m.k) {
    case "join": case "leave": return id(m.tab) ? m as unknown as Message : null;
    case "leader": case "bye": case "fault": case "signedOut": case "signedIn": return id(m.leader) ? m as unknown as Message : null;
    case "joined": return id(m.tab) && id(m.leader) && typeof m.binding === "string" ? m as unknown as Message : null;
    case "m": return id(m.tab) && typeof m.up === "boolean" && Number.isSafeInteger(m.s) && (m.s as number) >= 0 ? m as unknown as Message : null;
    default: return null;
  }
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
/** Replace every MessagePort in `value` with a stream marker. */
function encode(value: unknown, stream: (port: MessagePort) => number, depth = 0): unknown {
  if (value instanceof MessagePort) return {[MARK]: stream(value)};
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(v => encode(v, stream, depth + 1));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v, stream, depth + 1)]));
  return value;
}
/** Replace every stream marker with a fresh local port; collect them for transfer. */
function decode(value: unknown, port: (stream: number) => MessagePort, transfer: MessagePort[], depth = 0): unknown {
  if (plain(value) && Object.keys(value).length === 1 && Number.isSafeInteger(value[MARK])) {
    const local = port(value[MARK] as number); transfer.push(local); return local;
  }
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(v => decode(v, port, transfer, depth + 1));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, port, transfer, depth + 1)]));
  return value;
}

/** One tab's side of a tunnel: local ports bridged to numbered streams. The
 * leader numbers the streams it creates even, a follower odd; stream 0 is the
 * follower's Worker operation channel. */
class Tunnel {
  private readonly streams = new Map<number, MessagePort>();
  private next: number;
  constructor(private readonly send: (s: number, d: unknown) => void, private readonly up: boolean) { this.next = up ? 1 : 2; }
  bridge(port: MessagePort, s: number): void {
    this.streams.set(s, port);
    port.onmessage = event => {
      const d = event.ports.length ? encode(event.data, local => { const n = this.next; this.next += 2; this.bridge(local, n); return n; }) : event.data;
      try { this.send(s, d); } catch { /* the channel closed with the tab */ }
    };
  }
  deliver(s: number, d: unknown): void {
    const port = this.streams.get(s);
    if (!port) return;
    const transfer: MessagePort[] = [];
    const data = decode(d, n => { const channel = new MessageChannel(); this.bridge(channel.port1, n); return channel.port2; }, transfer);
    try { port.postMessage(data, transfer); } catch { for (const local of transfer) local.close(); }
  }
  close(): void {
    for (const port of this.streams.values()) { port.onmessage = null; try { port.close(); } catch { /* already closed */ } }
    this.streams.clear();
  }
}

/** This page's membership in its app's tab group. */
export class ApplicationTabs {
  readonly tab = crypto.randomUUID();
  private readonly base: string;
  private channel: BroadcastChannel | null = null;
  private presence: (() => void) | null = null;
  /** Held while this tab leads. */
  private leading: (() => void) | null = null;
  private hub: {readonly followers: Map<string, {binding: string; tunnel: Tunnel; watch: AbortController}>; readonly worker: ApplicationLeaderWorker; faulted: boolean} | null = null;
  private follower: {readonly leader: string; readonly tunnel: Tunnel; readonly wait: AbortController; readonly port: MessagePort; left: boolean; signedOut: boolean} | null = null;
  /** The leader is resigning because the session signed out. */
  private signingOut = false;
  /** This leader already told signed-out tabs that its session is signed in. */
  private announced = false;
  private joining: {readonly resolve: (link: {readonly binding: string; readonly leader: string}) => void; readonly reject: (error: unknown) => void} | null = null;
  constructor(scope: ApplicationTabsScope, private readonly env: ApplicationTabsEnvironment, private readonly lost: (signedOut: boolean) => void,
    private readonly signedInElsewhere: () => void = () => {}) {
    this.base = scope.storageNamespace===undefined?`${PROTOCOL}/${scope.cpOrigin}/${scope.appId}/${scope.build}`
      : `${PROTOCOL}/namespace/${JSON.stringify([scope.cpOrigin,scope.appId,scope.build,scope.storageNamespace])}`;
  }
  /** True while this tab runs the Worker for every tab. */
  get leader(): boolean { return this.leading !== null; }
  private open(): BroadcastChannel {
    if (this.channel) return this.channel;
    const channel = new this.env.BroadcastChannel(this.base);
    channel.onmessage = event => this.received(message(event.data));
    this.channel = channel;
    return channel;
  }
  private post(value: Message): void { this.channel?.postMessage(value); }
  /** Hold a lock until the returned release is called. */
  private hold(name: string, ifAvailable: boolean, signal?: AbortSignal): Promise<(() => void) | null> {
    return new Promise((resolve, reject) => {
      const callback = (lock: unknown) => {
        if (!lock) { resolve(null); return; }
        return new Promise<void>(release => resolve(release));
      };
      const request = ifAvailable ? this.env.locks.request(name, {ifAvailable: true}, callback) : this.env.locks.request(name, {signal}, callback);
      request.catch(reject);
    });
  }
  /** Lead if no tab of this app leads, else join the leader. */
  async elect(signal: AbortSignal): Promise<{readonly kind: "leader"} | ({readonly kind: "follower"} & ApplicationFollowerLink)> {
    signal.throwIfAborted();
    this.open();
    this.presence ??= await this.hold(`${this.base}/tab/${this.tab}`, true);
    signal.throwIfAborted();
    if (!this.leading) this.leading = await this.hold(`${this.base}/leader`, true);
    if (this.leading) {
      if (signal.aborted) { this.resign(); signal.throwIfAborted(); }
      return {kind: "leader"};
    }
    // Join the leader, and wait for leadership at the same time: if the leader
    // is just leaving, the lock comes first and this tab leads instead.
    const wait = new AbortController(), stopWaiting = () => wait.abort();
    signal.addEventListener("abort", stopWaiting, {once: true});
    const lock = this.hold(`${this.base}/leader`, false, wait.signal);
    let outcome: {readonly release: () => void} | {readonly binding: string; readonly leader: string};
    try {
      outcome = await new Promise((resolve, reject) => {
        lock.then(release => { if (release) resolve({release}); }, () => { /* aborted */ });
        this.joining = {resolve, reject};
        signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        this.post({k: "join", tab: this.tab});
      });
    } catch (error) { this.joining = null; wait.abort(); throw error; }
    finally { signal.removeEventListener("abort", stopWaiting); }
    this.joining = null;
    if ("release" in outcome) {
      this.leading = outcome.release;
      if (signal.aborted) { this.resign(); signal.throwIfAborted(); }
      return {kind: "leader"};
    }
    if (signal.aborted) { wait.abort(); signal.throwIfAborted(); }
    const local = new MessageChannel(), tab = this.tab;
    const tunnel = new Tunnel((s, d) => this.post({k: "m", tab, up: true, s, d}), true);
    tunnel.bridge(local.port2, 0);
    const follower = {leader: outcome.leader, tunnel, wait, port: local.port1, left: false, signedOut: false};
    this.follower = follower;
    // Take over when the leader goes. The lock is kept: this tab leads next.
    void lock.then(release => {
      if (!release) return;
      if (this.follower !== follower || follower.left) { release(); return; }
      this.leading = release; this.departed(follower);
    }, () => { /* left first */ });
    return {kind: "follower", port: local.port1, binding: outcome.binding, leave: () => this.leave(follower)};
  }
  /** Leader: forward follower tabs onto this tab's Worker. */
  lead(worker: ApplicationLeaderWorker): void {
    if (!this.leading || this.hub) return;
    this.hub = {followers: new Map(), worker, faulted: false};
    this.post({k: "leader", leader: this.tab});
  }
  /** Leader: the shared Worker failed. Every follower's session fails with it,
   * the same way this tab's does; it is not replaced while this tab holds it. */
  fault(): void {
    if (!this.hub || this.hub.faulted) return;
    this.hub.faulted = true;
    this.post({k: "fault", leader: this.tab});
  }
  /** Leader: the session signed out. Followers hear it now, before this tab's
   * Worker stops and it resigns, so when the leader goes they sign out instead
   * of starting a new session as the next leader. */
  signedOut(): void {
    if (!this.hub) return;
    this.signingOut = true;
    this.post({k: "signedOut", leader: this.tab});
  }
  /** Leader: the session is signed in. Tabs left signed out (every tab signed
   * out, then this one signed in again) join it rather than staying out. */
  signedIn(): void {
    if (!this.hub || this.announced || this.signingOut) return;
    this.announced = true;
    this.post({k: "signedIn", leader: this.tab});
  }
  /** Leader: stop leading (the Worker stopped). Followers re-elect. */
  resign(): void {
    const hub = this.hub, signedOut = this.signingOut; this.hub = null; this.signingOut = false; this.announced = false;
    // "bye" goes before the lock, so a follower hears why before it can lead.
    if (hub) this.post({k: "bye", leader: this.tab, ...(signedOut ? {signedOut: true as const} : {})});
    const release = this.leading; this.leading = null; release?.();
    if (hub) {
      for (const follower of hub.followers.values()) { follower.watch.abort(); follower.tunnel.close(); }
      hub.followers.clear();
    }
  }
  private leave(follower: NonNullable<ApplicationTabs["follower"]>): void {
    if (follower.left) return;
    follower.left = true; follower.wait.abort(); follower.tunnel.close();
    if (this.follower === follower) { this.follower = null; this.post({k: "leave", tab: this.tab}); }
  }
  /** The leader went away: this tab's runtime restarts (as leader or follower). */
  private departed(follower: NonNullable<ApplicationTabs["follower"]>, signedOut = false): void {
    if (follower.left || this.follower !== follower) return;
    follower.left = true; follower.wait.abort(); follower.tunnel.close(); this.follower = null;
    this.lost(signedOut || follower.signedOut);
  }
  /** Page leaving or entry closing: let go of everything. */
  release(): void {
    this.joining?.reject(new DOMException("released", "AbortError")); this.joining = null;
    if (this.follower) this.leave(this.follower);
    this.resign();
    const presence = this.presence; this.presence = null; presence?.();
    if (this.channel) { this.channel.onmessage = null; this.channel.close(); this.channel = null; }
  }
  private received(m: Message | null): void {
    if (!m) return;
    const hub = this.hub, follower = this.follower;
    switch (m.k) {
      case "join": {
        if (!hub || hub.followers.has(m.tab) || m.tab === this.tab) return;
        const binding = crypto.randomUUID(), channel = new MessageChannel(), tab = m.tab;
        const tunnel = new Tunnel((s, d) => this.post({k: "m", tab, up: false, s, d}), false);
        tunnel.bridge(channel.port1, 0);
        const watch = new AbortController();
        hub.followers.set(tab, {binding, tunnel, watch});
        try { hub.worker.attach(channel.port2, binding); } catch { hub.followers.delete(tab); tunnel.close(); return; }
        this.post({k: "joined", tab, binding, leader: this.tab});
        if (hub.faulted) this.post({k: "fault", leader: this.tab});
        // A follower that vanishes without "leave" releases its presence lock.
        void this.hold(`${this.base}/tab/${tab}`, false, watch.signal).then(release => { release?.(); this.drop(hub, tab); }, () => {});
        return;
      }
      case "leave": if (hub) this.drop(hub, m.tab); return;
      case "joined":
        if (m.tab === this.tab && this.joining) { const joining = this.joining; this.joining = null; joining.resolve({binding: m.binding, leader: m.leader}); }
        return;
      case "leader":
        // A new leader is ready: a tab still waiting to join asks again.
        if (this.joining) this.post({k: "join", tab: this.tab});
        return;
      case "bye":
        if (follower && follower.leader === m.leader) this.departed(follower, m.signedOut === true);
        return;
      case "signedOut":
        if (follower && follower.leader === m.leader) follower.signedOut = true;
        return;
      case "signedIn":
        if (!hub && !follower && !this.joining && m.leader !== this.tab) this.signedInElsewhere();
        return;
      case "fault":
        // The follower's runtime reads it as its own Worker failing.
        if (follower && !follower.left && follower.leader === m.leader) follower.port.dispatchEvent(new MessageEvent("messageerror"));
        return;
      case "m":
        if (m.up && hub) hub.followers.get(m.tab)?.tunnel.deliver(m.s, m.d);
        else if (!m.up && follower && m.tab === this.tab) follower.tunnel.deliver(m.s, m.d);
        return;
    }
  }
  private drop(hub: NonNullable<ApplicationTabs["hub"]>, tab: string): void {
    const follower = hub.followers.get(tab);
    if (!follower) return;
    hub.followers.delete(tab); follower.watch.abort(); follower.tunnel.close();
    try { hub.worker.detach(follower.binding); } catch { /* the Worker stopped */ }
  }
}
