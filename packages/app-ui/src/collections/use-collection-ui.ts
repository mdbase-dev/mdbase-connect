import { useLocaleRevision } from "../i18n.js";
import type { Mdbase, MdbaseProblem } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { defaultCollectionCopy, fill, type CollectionCopy } from "./copy.js";
import { actionNotice, collectionView, type CollectionNotice, type CollectionRow, type CollectionView, type ProblemControl } from "./model.js";
import { planNeedsReview, unsyncedApi, type UnsyncedPlan, type UnsyncedResult, type UnsyncedTransferMap } from "./unsynced.js";

/** The only app-specific input: what the app is called, and its mark. */
export interface CollectionAppIdentity {
  readonly name: string;
  readonly mark?: ReactNode;
}

export type LeaveIntent = "switch" | "add" | "choose_another" | "sign_out";

/** Work before connecting: the app created its entry with `{unsynced: true}`. */
export interface CollectionUnsyncedOptions {
  /** Where that work is kept: "Saved only in this browser" (default) or, in a native shell, "on this device". */
  readonly storage?: "browser" | "device" | undefined;
  /** Reshape or leave out records when bringing the work into a collection. Default: as they are. */
  readonly map?: UnsyncedTransferMap | undefined;
}

/** A collection the app lists itself (one the SDK doesn't), in an app section. */
export interface CollectionSectionItem {
  readonly id: string;
  readonly name: string;
  /** A second line under the name: where it lives, or which account. */
  readonly detail?: string | null | undefined;
  /** Open in the app now. With `renderAppCollection`, the gate shows the app instead of its screens. */
  readonly current?: boolean | undefined;
  /** Listed but not selectable; say why in `detail`. */
  readonly disabled?: boolean | undefined;
  /** The row's menu, like an SDK collection's: shown when there is at least one. */
  readonly actions?: readonly CollectionSectionItemAction[] | undefined;
}

/** An entry in an app section item's row menu. */
export interface CollectionSectionItemAction {
  readonly id: string;
  readonly label: string;
  /** Runs in the click, after the menu closes and focus is back on the row's menu button. */
  readonly onSelect: (item: CollectionSectionItem, context: CollectionSectionItemActionContext) => void;
  /** Destructive: shown in the danger colour. Confirm before acting, for example with `confirmDelete`. */
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * How the delete dialog ended: `deleted`; `cancelled` with no attempt; `failed`
 * when the person closed it after a delete was refused.
 */
export type DeleteCollectionOutcome = "deleted" | "cancelled" | "failed";

/** What a section item action can ask of the screen that shows its menu. */
export interface CollectionSectionItemActionContext {
  /**
   * Open `DeleteCollectionDialog` for the item: the person types its name, then
   * the SDK deletes it by the item's id. `onClose` gets the outcome.
   */
  readonly confirmDelete: (onClose?: (outcome: DeleteCollectionOutcome) => void) => void;
}

/**
 * A titled group of app-listed collections, shown after "Your collections" on
 * the gate's choosing and signed-out screens and in the switcher.
 */
export interface CollectionSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly CollectionSectionItem[];
  /** Open an item. Runs in the click, after `onBeforeLeave("switch")` when something else is open. */
  readonly onSelect: (item: CollectionSectionItem) => void;
  /** Close the open item: the person chose another collection or went back to the list. */
  readonly onClose?: ((item: CollectionSectionItem) => void) | undefined;
  /** Shown when there are no items. Without it an empty section is hidden. */
  readonly empty?: string | undefined;
}

/** The app section item that is open, if any. */
export interface OpenSectionItem {
  readonly section: CollectionSection;
  readonly item: CollectionSectionItem;
}

export interface CollectionUiOptions {
  /** The app's entry from `createMdbase`. */
  readonly mdbase: Mdbase;
  readonly app: CollectionAppIdentity;
  /**
   * Asked before anything that leaves the open collection. Return false to stay.
   * Return a promise to ask first (an unsaved-work dialog): resolve it from that
   * dialog's own click, and the shared UI continues in the same task, so a
   * Connect window it opens still counts as the person's gesture.
   */
  readonly onBeforeLeave?: ((intent: LeaveIntent) => boolean | Promise<boolean>) | undefined;
  /** @deprecated Presentation-only compatibility option; the single Add entry always uses the SDK chooser. */
  readonly allowPrivate?: boolean | undefined;
  /** Offer "Delete collection…" to owners. Default false. */
  readonly allowDelete?: boolean | undefined;
  /** Replacement or translated copy by key. */
  readonly copy?: Partial<CollectionCopy> | undefined;
  /** App-listed collections, in sections after the SDK's own list. */
  readonly sections?: readonly CollectionSection[] | undefined;
  /** A second line for an SDK collection row (where it lives, which account), from the row and its SDK entry. */
  readonly rowDetail?: ((row: CollectionRow) => string | null | undefined) | undefined;
  /** Work before connecting: "Continue without connecting" when signed out, the "Saved only in this browser" line, and bringing that work into the collection the person opens. */
  readonly unsynced?: CollectionUnsyncedOptions | boolean | undefined;
}

/** `add_private` remains available to legacy track callers; both add APIs now emit `add`. */
export type CollectionActionName = "sign_in" | "add" | "add_private" | "approve" | "select" | "choose_another" | "assess" | "start" | "sign_out" | "setup" | "open_unsynced" | "bring_in" | "discard_unsynced";

interface ActionError { readonly kind: CollectionView["kind"]; readonly notice: CollectionNotice }

export interface CollectionUi {
  readonly view: CollectionView;
  readonly copy: CollectionCopy;
  readonly say: (key: keyof CollectionCopy, values?: Readonly<Record<string, string>>) => string;
  readonly options: CollectionUiOptions;
  /** The running action, if any. Its controls stay focusable but inert. */
  readonly busy: CollectionActionName | null;
  /** The last failed action's SDK description, while the phase is unchanged. */
  readonly error: CollectionNotice | null;
  /** Set when sign-out found unsaved changes: the SDK's copy for the confirm. */
  readonly signOutPrompt: MdbaseProblem | null;
  /** The open app section item, which takes the place of the SDK's current collection. */
  readonly appOpen: OpenSectionItem | null;
  /** A plan to bring unsynced work in that has something to confirm (renames, types). */
  readonly unsyncedReview: UnsyncedPlan | null;
  /** How bringing unsynced work in ended, until dismissed or the screen changes. */
  readonly unsyncedNotice: CollectionNotice | null;
  readonly actions: CollectionActions;
}

export interface CollectionActions {
  signIn(): void;
  addCollection(): void;
  /** @deprecated Use addCollection. Both names open the same SDK chooser. */
  addPrivateCollection(): void;
  approve(collectionId: string | null): void;
  select(collectionId: string): void;
  /** Open an app section item, closing whatever app item was open. */
  selectItem(section: CollectionSection, item: CollectionSectionItem): void;
  /** Back to the list: closes the open app item, or the SDK's collection. */
  chooseAnother(): void;
  /** Open the Connect window again for the authorization in progress. */
  reopen(): void;
  /** Abandon the authorization this page started. */
  cancel(): void;
  assess(): void;
  start(): void;
  signOut(): void;
  confirmSignOut(): void;
  dismissSignOut(): void;
  /** Run a problem's own control. `set_up` goes to `onSetUp`. */
  perform(control: ProblemControl, onSetUp?: () => void): void;
  /** Track an app-ui call that is not a button above (setup), so errors show the same way. */
  track(name: CollectionActionName, call: () => Promise<unknown>): Promise<unknown>;
  /** "Connect to sync your work": sign in, or choose a collection when signed in. */
  connect(): void;
  /** Open the app's unsynced collection (work before connecting). */
  continueWithoutConnecting(): void;
  /** Bring unsynced work into the open collection; asks first (`unsyncedReview`) when there is something to confirm. */
  bringIn(): void;
  confirmBringIn(): void;
  dismissBringIn(): void;
  /** Erase the unsynced work. Only after the person confirmed it. */
  discardUnsynced(): void;
  dismissUnsyncedNotice(): void;
}

const popupActions: ReadonlySet<CollectionActionName> = new Set(["sign_in", "add", "add_private", "approve"]);

/** The first current item across the app's sections. */
export function appOpenItem(sections: readonly CollectionSection[] | undefined): OpenSectionItem | null {
  for (const section of sections ?? []) {
    const item = section.items.find((candidate) => candidate.current);
    if (item) return { section, item };
  }
  return null;
}

const starting = new WeakSet<Mdbase>();

/**
 * Start the front door once it is rendered, while it has not started. `start()`
 * is safe to call again; this also skips calls while one is in flight, so
 * several gates and StrictMode's double effects make one call.
 */
export function useAutoStart(mdbase: Mdbase, enabled = true): void {
  const notStarted = useSyncExternalStore(mdbase.subscribe, () => mdbase.getSnapshot().status === "not_started", () => false);
  useEffect(() => {
    if (!enabled || !notStarted || starting.has(mdbase)) return;
    starting.add(mdbase);
    const done = (): void => { starting.delete(mdbase); };
    // A failed start shows as the snapshot's problem.
    new Promise((resolve) => { resolve(mdbase.start()); }).then(done, done);
  }, [mdbase, enabled, notStarted]);
}

/** Subscribe to the app's mdbase entry and get its view plus gesture-safe actions. */
export function useCollectionUi(options: CollectionUiOptions): CollectionUi {
  const { mdbase, app } = options;
  const snapshot = useSyncExternalStore(mdbase.subscribe, mdbase.getSnapshot, mdbase.getSnapshot);
  const localeRevision = useLocaleRevision();
  const copy = useMemo(() => ({ ...defaultCollectionCopy, ...options.copy }), [options.copy, localeRevision]);
  const view = useMemo(() => collectionView(snapshot, { appName: app.name, copy }), [snapshot, app.name, copy]);
  const [busy, setBusy] = useState<CollectionActionName | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  useEffect(() => {
    setError(previous => previous?.notice.key === "account_collection_quota_exceeded" ? null : previous);
  }, [snapshot.collections.length]);
  const [signOutPrompt, setSignOutPrompt] = useState<MdbaseProblem | null>(null);
  const [unsyncedReview, setUnsyncedReview] = useState<UnsyncedPlan | null>(null);
  const reviewing = useRef<UnsyncedPlan | null>(null);
  /** How bringing work in ended, for the collection it went into. */
  const [unsyncedNotice, setUnsyncedNotice] = useState<{ readonly collectionId: string; readonly notice: CollectionNotice } | null>(null);
  const running = useRef<{ name: CollectionActionName; controller: AbortController } | null>(null);
  const latest = useRef({ options, view, copy });
  latest.current = { options, view, copy };

  const actions = useMemo<CollectionActions>(() => {
    /**
     * Calls the SDK first, synchronously, then records state: Connect windows
     * are reserved inside `call`, before anything here awaits.
     */
    const run = (name: CollectionActionName, call: (signal: AbortSignal) => Promise<unknown>, again = false): Promise<unknown> => {
      if (running.current && !again) return Promise.resolve();
      const controller = new AbortController();
      let pending: Promise<unknown>;
      try { pending = call(controller.signal); } catch (cause) { pending = Promise.reject(cause); }
      const kind = latest.current.view.kind;
      running.current = { name, controller };
      setBusy(name);
      setError(null);
      return pending.then(() => undefined, (cause: unknown) => {
        const problem = describeError(cause);
        if (problem) console.info("[mdbase collections]", problem.code, problem.developerMessage ?? "");
        if (name === "sign_out" && problem?.key === "sign_out_pending_writes") setSignOutPrompt(problem);
        else if (!controller.signal.aborted) {
          const notice = actionNotice(problem);
          setError(notice ? { kind, notice } : null);
        }
      }).finally(() => {
        if (running.current?.controller !== controller) return;
        running.current = null;
        setBusy(null);
      });
    };
    /** Ask the app first when leaving the open collection; continue in the same task when it agrees. */
    const leave = (intent: LeaveIntent, go: () => void): void => {
      const { options: current, view: now } = latest.current;
      const open = now.current !== null || appOpenItem(current.sections) !== null;
      const answer = open && current.onBeforeLeave ? current.onBeforeLeave(intent) : true;
      if (answer === true) go();
      else if (answer !== false) void answer.then((ok) => { if (ok) go(); }, () => {});
    };
    const addCollection = () => leave("add", () => { void run("add", (signal) => mdbase.addCollection({ signal })); });
    const review = (plan: UnsyncedPlan | null): void => { reviewing.current = plan; setUnsyncedReview(plan); };
    const unsyncedMap = (): UnsyncedTransferMap | undefined => {
      const value = latest.current.options.unsynced;
      return typeof value === "object" ? value.map : undefined;
    };
    /** Report how a transfer into `into` ended. A retired copy leaves nothing more to bring in. */
    const brought = (result: UnsyncedResult, into: { readonly id: string; readonly name: string }): void => {
      const words = latest.current.copy;
      const failed = result.failed.length > 0 || (result.failedTypes?.length ?? 0) > 0;
      // Everything planned went in, but the work stays: it is still open (or was saved to) elsewhere.
      const open = !failed && result.retired === false;
      const notice: CollectionNotice = failed
        ? { key: "unsynced_bring_in_failed", tone: "warning", title: null, message: words.unsyncedBringInFailed, control: null, transient: false }
        : { key: open ? "unsynced_brought_in_open" : "unsynced_brought_in", tone: "info", title: null,
          message: fill(open ? words.unsyncedBroughtInOpen : words.unsyncedBroughtIn, { collection: into.name }), control: null, transient: false };
      setUnsyncedNotice({ collectionId: into.id, notice });
    };
    /** The open collection work would be brought into. */
    const destination = (): { readonly id: string; readonly name: string } | null => {
      const now = latest.current.view;
      return now.kind === "ready" && now.current ? { id: now.current.id, name: now.current.name } : null;
    };
    const actions: CollectionActions = {
      signIn: () => { void run("sign_in", (signal) => mdbase.signIn({ signal })); },
      addCollection,
      addPrivateCollection: addCollection,
      approve: (id) => { void run("approve", (signal) => mdbase.approve(id ?? undefined, { signal })); },
      select: (id) => {
        const app = appOpenItem(latest.current.options.sections);
        if (!app && latest.current.view.current?.id === id) return;
        leave("switch", () => {
          app?.section.onClose?.(app.item);
          void run("select", (signal) => mdbase.select(id, { signal }));
        });
      },
      selectItem: (section, item) => {
        if (item.current || item.disabled) return;
        leave("switch", () => {
          const app = appOpenItem(latest.current.options.sections);
          if (app && app.item.id !== item.id) app.section.onClose?.(app.item);
          section.onSelect(item);
        });
      },
      chooseAnother: () => leave("choose_another", () => {
        const app = appOpenItem(latest.current.options.sections);
        app?.section.onClose?.(app.item);
        if (!app || latest.current.view.current) void run("choose_another", (signal) => mdbase.chooseAnother({ signal }));
      }),
      reopen: () => {
        const now = latest.current.view;
        if (now.kind !== "authorizing") return;
        const call = now.purpose === "sign_in" ? (signal: AbortSignal) => mdbase.signIn({ signal })
          : now.purpose === "add" ? (signal: AbortSignal) => mdbase.addCollection({ signal })
            : (signal: AbortSignal) => mdbase.approve(now.collectionId ?? undefined, { signal });
        void run(now.purpose === "sign_in" ? "sign_in" : now.purpose === "add" ? "add" : "approve", call, true);
      },
      cancel: () => {
        const current = running.current;
        if (current && popupActions.has(current.name)) current.controller.abort();
      },
      assess: () => { void run("assess", (signal) => mdbase.assess({ signal })); },
      start: () => {
        const collectionId = mdbase.getSnapshot().selectedCollectionId;
        void run("start", (signal) => collectionId ? mdbase.select(collectionId, { signal }) : mdbase.start({ signal }));
      },
      signOut: () => leave("sign_out", () => { void run("sign_out", (signal) => mdbase.signOut({ signal })); }),
      confirmSignOut: () => {
        setSignOutPrompt(null);
        void run("sign_out", (signal) => mdbase.signOut({ signal, discard: true }), true);
      },
      dismissSignOut: () => setSignOutPrompt(null),
      perform: (control, onSetUp) => {
        switch (control.kind) {
          case "sign_in": return actions.signIn();
          case "approve": return actions.approve(control.collectionId);
          case "choose_another": return actions.chooseAnother();
          case "set_up": return onSetUp?.();
          case "assess": return actions.assess();
          case "start": return actions.start();
          case "reload": return globalThis.location?.reload();
          case "link": return undefined;
        }
      },
      track: (name, call) => run(name, call, true),
      connect: () => { if (latest.current.view.signedIn) addCollection(); else actions.signIn(); },
      continueWithoutConnecting: () => {
        const api = unsyncedApi(mdbase);
        if (api) void run("open_unsynced", (signal) => api.open({ signal }));
      },
      bringIn: () => {
        const api = unsyncedApi(mdbase), into = destination();
        if (!api || !into) return;
        setUnsyncedNotice(null);
        const map = unsyncedMap();
        void run("bring_in", async (signal) => {
          // New types come from the work's own definitions; adding them, or renaming, is confirmed first.
          const plan = await api.planTransfer({ ...(map ? { map } : {}), addTypes: true, signal });
          if (planNeedsReview(plan)) { review(plan); return; }
          brought(await api.transfer(plan, { signal }), into);
        });
      },
      confirmBringIn: () => {
        const api = unsyncedApi(mdbase), plan = reviewing.current, into = destination();
        review(null);
        // A plan for a collection that is no longer open is dropped, not run.
        if (plan && api && into?.id === plan.destination) void run("bring_in", async (signal) => { brought(await api.transfer(plan, { signal }), into); });
      },
      dismissBringIn: () => review(null),
      discardUnsynced: () => {
        const api = unsyncedApi(mdbase);
        if (api) void run("discard_unsynced", (signal) => api.discard({ signal }));
      },
      dismissUnsyncedNotice: () => setUnsyncedNotice(null),
    };
    return actions;
  }, [mdbase]);

  const say = useMemo(() => (key: keyof CollectionCopy, values: Readonly<Record<string, string>> = {}) =>
    fill(copy[key], { app: app.name, ...values }), [copy, app.name]);

  return {
    view, copy, say, options, busy, signOutPrompt, actions,
    appOpen: appOpenItem(options.sections),
    error: error && error.kind === view.kind ? error.notice : null,
    unsyncedReview: view.kind === "ready" && unsyncedReview?.destination === view.current?.id ? unsyncedReview : null,
    unsyncedNotice: view.kind === "ready" && unsyncedNotice && unsyncedNotice.collectionId === view.current?.id ? unsyncedNotice.notice : null,
  };
}
