import {AppWebSignInSession, type AppWebSignInSessionOptions, type AppWebSignInSnapshot} from "./web-sign-in-session.js";
import {AppInstallationSignInError, type AppFileAction} from "./installation-sign-in.js";
import {createAppSignInRootGuard} from "./owner.js";

/** Worker-owned collection actor routing. A replacement uses the SAME protected
 * SDK sign-in/native lifecycle in a new local slot; no credential, receipt or
 * cached listing is copied from the original installation into that slot. */
export class AppScopedSignInSession<Connection> {
  readonly original: AppWebSignInSession<Connection>;
  private readonly scoped = new Map<string, {reference: string; session: AppWebSignInSession<Connection>; stop: () => void}>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private focus: string | null = null;
  private approvalOwner: AppWebSignInSession<Connection> | null = null;
  private foreground = true;
  private readonly quarantined = new Set<string>();
  private closing: Promise<void> | null = null;
  private readonly rootGuard: ReturnType<typeof createAppSignInRootGuard> | null;
  private readonly options: Readonly<AppWebSignInSessionOptions<Connection>>;
  private readonly onAbort = () => {void this.close().catch(() => {/* failed drains retain the root guard */});};
  constructor(options: Readonly<AppWebSignInSessionOptions<Connection>>) {
    // Without a lock port the original protected store still refuses opening.
    // The bridge is private to this fixed composition, not a public bypass flag.
    this.rootGuard = options.locks ? createAppSignInRootGuard(options.locks, options, options.signal) : null;
    this.options = Object.freeze({...options, locks: this.rootGuard?.locks ?? options.locks});
    this.original = new AppWebSignInSession(this.options);
    this.unsubscribe = this.original.subscribe(() => this.changed());
    options.signal.addEventListener("abort", this.onAbort, {once: true});
  }
  private check(): void {if (this.closing || this.options.signal.aborted) throw new AppInstallationSignInError("fenced");}
  private changed(): void {if (!this.closing)for(const listener of [...this.listeners])try {listener();} catch {/* publication cannot interrupt ownership */}}
  subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
  private removed(session: AppWebSignInSession<Connection>, id: string): boolean {
    return session.scopeWasRemoved(id);
  }
  private collections() {
    const context = this.original.scopeRecoveryContext();
    const rows = this.original.getSnapshot().collections.filter(c => !Object.hasOwn(context?.references ?? {}, c.collectionId) && !this.removed(this.original, c.collectionId));
    for(const [id, actor] of this.scoped)if(!this.removed(actor.session, id))rows.push(...actor.session.getSnapshot().collections.filter(c => c.collectionId === id));
    return Object.freeze(rows);
  }
  getSnapshot(): AppWebSignInSnapshot {return this.compose(this.focus);}
  viewFor(id: string | null, options: {readonly bystander?: boolean} = {}): AppWebSignInSnapshot {return this.compose(id, options);}
  private compose(id: string | null, options: {readonly bystander?: boolean} = {}): AppWebSignInSnapshot {
    const actor = id === null ? undefined : this.scoped.get(id);
    const session = actor?.session ?? this.original;
    let view = session.viewFor(id, options);
    if (!options.bystander && this.approvalOwner?.getSnapshot().status === "authorizing") view = this.approvalOwner.viewFor(id);
    // A cancelled/expired fresh attempt is still a removed collection of the
    // ORIGINAL signed-in account, not a global sign-out or new consent.
    if (actor && view.status === "signed_out") view = {...this.original.viewFor(null), selectedCollectionId: null, status: "unselected", problem: null, approval: view.approval};
    const candidates = new Set([...this.original.removedScopeIds(), ...Object.keys(this.original.scopeRecoveryContext()?.references ?? {})]);
    const removedScopeIds = Object.freeze([...candidates].filter(cid => {
      const scoped = this.scoped.get(cid)?.session;
      return !scoped || this.removed(scoped, cid) || scoped.getSnapshot().status === "signed_out";
    }));
    const accountLabel = actor && view.problem === "recovery_account_mismatch" ? this.original.scopeRecoveryContext()?.accountLabel : null;
    const nativeGrants=new Map((this.original.getSnapshot().signIn?.nativeGrants ?? []).map(c=>[c.collection_id,c]));
    const account=this.original.getSnapshot().signIn?.accountId;
    for(const child of this.scoped.values())for(const c of child.session.getSnapshot().signIn?.nativeGrants ?? [])if(c.account_id===account)nativeGrants.set(c.collection_id,c);
    const signIn=view.signIn?Object.freeze({...view.signIn,nativeGrants:Object.freeze([...nativeGrants.values()])}):null;
    return Object.freeze({...view, signIn, collections: this.collections(), removedScopeIds, ...(accountLabel ? {recoveryAccountLabel: accountLabel} : {})});
  }
  connection(id: string | null = this.focus): Connection | null {
    if (id === null || this.closing) return null;
    const actor = this.scoped.get(id);
    if (actor) return actor.session.connection(id);
    if (Object.hasOwn(this.original.scopeRecoveryContext()?.references ?? {}, id)) return null;
    return this.original.connection(id);
  }
  heldCollections(): string[] {return [...new Set([...this.original.heldCollections(), ...[...this.scoped.values()].flatMap(actor => actor.session.heldCollections())])];}
  private child(id: string, reference: string, accountId: string, fresh = false): AppWebSignInSession<Connection> {
    const existing = this.scoped.get(id);
    if (existing) {if(existing.reference !== reference)throw new AppInstallationSignInError("fenced"); return existing.session;}
    const session = new AppWebSignInSession<Connection>({...this.options, owner: `${this.options.owner ?? `app:${this.options.appId}`}:scope:${reference}`,
      requestedCreateCollections: false, freshRequestedCreateCollections: false, recoveryFor: Object.freeze({accountId, collectionId: id}), autoSelect: "never", storeMode: fresh ? "fresh" : "existing"});
    const stop = session.subscribe(() => this.changed());
    this.scoped.set(id, {reference, session, stop}); session.setForeground(this.foreground);
    return session;
  }
  async start(): Promise<AppWebSignInSnapshot> {
    this.check(); await this.original.start(); this.check();
    const context = this.original.scopeRecoveryContext();
    if (context)for(const [id, reference] of Object.entries(context.references))if(reference !== null) {
      const session = this.child(id, reference, context.accountId);
      try {await session.start();} catch {/* failed original child ledger remains visibly blocked, never replaced */}
      this.check();
    }
    this.changed(); return this.getSnapshot();
  }
  async authorize(options: {readonly collectionHint?: string | null} = {}): Promise<AppWebSignInSnapshot> {
    this.check(); const id = options.collectionHint ?? null;
    if (this.approvalOwner?.getSnapshot().status === "authorizing") throw new AppInstallationSignInError("busy");
    const context = this.original.scopeRecoveryContext(), actor = id === null ? undefined : this.scoped.get(id);
    if (id === null || !context || (!Object.hasOwn(context.references, id) && !this.removed(this.original, id))) {
      this.approvalOwner = this.original;
      await this.original.authorize(options); this.check(); return this.getSnapshot();
    }
    this.focus = id;
    if (this.quarantined.has(id)) throw new AppInstallationSignInError("recovery_required");
    let reference = context.references[id], freshSlot = false;
    if (actor && (this.removed(actor.session, id) || actor.session.canAbandonWrongAccount())) {
      // Only an explicit gesture can abandon a definite pre-proof wrong-account
      // browser attempt. Both IDs come from a NEW protected local slot, not a
      // new window on the old IDs; the old CP pending row expires naturally.
      // This actor has only the requested collection. Its isolated erasure
      // cannot touch the global actor, shared journals or other scopes.
      try {
        const result = await actor.session.signOut();
        if (result.signOutResult?.local !== "erased") throw new AppInstallationSignInError("recovery_required");
        await actor.session.close(); actor.stop(); this.scoped.delete(id); this.check();
      } catch (error) {this.quarantined.add(id); throw error;}
      const fresh = await this.original.prepareScopedRecovery(id, actor.reference); this.check(); reference = fresh.reference; freshSlot = true;
    } else if (reference === null || reference === undefined) {
      const fresh = await this.original.prepareScopedRecovery(id); this.check(); reference = fresh.reference; freshSlot = true;
    }
    const session = this.child(id, reference, context.accountId, freshSlot);
    await session.start(); this.check(); this.approvalOwner = session; await session.authorize({collectionHint: id}); this.check();
    this.changed(); return this.getSnapshot();
  }
  async openCollection(id: string): Promise<AppWebSignInSnapshot> {
    this.check(); this.focus = id;
    const actor = this.scoped.get(id);
    if (!actor && Object.hasOwn(this.original.scopeRecoveryContext()?.references ?? {}, id)) throw new AppInstallationSignInError("refused");
    await (actor?.session ?? this.original).openCollection(id); this.check(); return this.getSnapshot();
  }
  async releaseCollection(id: string): Promise<AppWebSignInSnapshot> {await (this.scoped.get(id)?.session ?? this.original).releaseCollection(id); return this.getSnapshot();}
  async forget(id: string): Promise<AppWebSignInSnapshot> {await (this.scoped.get(id)?.session ?? this.original).forget(id); return this.getSnapshot();}
  async deleteCollection(id: string, name: string): Promise<AppWebSignInSnapshot> {await (this.scoped.get(id)?.session ?? this.original).deleteCollection(id, name); return this.getSnapshot();}
  async requestFileAccess(id: string, actions: readonly AppFileAction[], reason: string): Promise<AppWebSignInSnapshot> {await (this.scoped.get(id)?.session ?? this.original).requestFileAccess(id, actions, reason); return this.getSnapshot();}
  async pollFileAccess(requestId: string): Promise<AppWebSignInSnapshot> {
    const session = [...this.scoped.values()].find(actor => actor.session.getSnapshot().fileAccess?.requestId === requestId)?.session ?? this.original;
    await session.pollFileAccess(requestId); return this.getSnapshot();
  }
  async refreshCollectionList(): Promise<AppWebSignInSnapshot> {
    await this.original.refreshCollectionList();
    for(const actor of this.scoped.values()) {this.check(); await actor.session.refreshCollectionList();}
    this.changed(); return this.getSnapshot();
  }
  setForeground(active: boolean): void {this.check(); this.foreground = active; this.original.setForeground(active); for(const actor of this.scoped.values())actor.session.setForeground(active);}
  approvalWindowClosed(): void {(this.approvalOwner ?? this.original).approvalWindowClosed();}
  async renewExpiredPairing(): Promise<AppWebSignInSnapshot> {await (this.approvalOwner ?? this.original).renewExpiredPairing(); return this.getSnapshot();}
  async signOut(): Promise<AppWebSignInSnapshot> {
    this.check();
    for(const [id, actor] of this.scoped) {
      const result = await actor.session.signOut();
      if (result.signOutResult?.local !== "erased") {this.quarantined.add(id); throw new AppInstallationSignInError("recovery_required");}
      await actor.session.close(); actor.stop(); this.scoped.delete(id);
    }
    await this.original.signOut(); this.focus = null; this.approvalOwner = null; this.quarantined.clear(); this.changed(); return this.getSnapshot();
  }
  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closing = Promise.resolve().then(async () => {
      for(const actor of this.scoped.values()) {await actor.session.close(); actor.stop();}
      await this.original.close();
      await this.rootGuard?.close();
      this.options.signal.removeEventListener("abort", this.onAbort);
      this.unsubscribe(); this.scoped.clear(); this.listeners.clear();
    });
    return this.closing;
  }
}
