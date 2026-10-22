// @vitest-environment jsdom
import type { Mdbase, MdbasePhase, MdbaseSnapshot } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionGate, CollectionSwitcher, CollectionSaveWarning, DeleteCollectionDialog, useCollectionUi, type CollectionSection, type DeleteCollectionOutcome } from "../collections.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const app = { name: "TaskNotes" };

function fakeMdbase(phase: MdbasePhase, extra: Partial<MdbaseSnapshot> = {}) {
  let value = {
    status: "unselected",
    signIn: { state: "paired", accountEmail: "ada@example.com" },
    collections: [
      { collectionId: A, displayName: "Alpha", role: "owner" },
      { collectionId: B, displayName: "Beta", role: "editor" },
      { collectionId: C, displayName: "Gamma", role: "viewer" },
    ],
    selectedCollectionId: null,
    problem: null,
    timing: null,
    readiness: { checking: false, assessment: null, problem: null, facets: {} },
    selection: { state: "none", problem: null, usable: null, requested: { collectionId: null, source: "none", displayName: null, approved: false } },
    phase,
    sync: null,
    links: { account: "https://connect.example/account", manageAccess: "https://connect.example/account/applications" },
    ...extra,
  } as unknown as MdbaseSnapshot;
  const listeners = new Set<() => void>();
  const pending = () => new Promise<MdbaseSnapshot>(() => {});
  const mdbase = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    signIn: vi.fn(pending),
    addCollection: vi.fn((_options?: { readonly signal?: AbortSignal }) => pending()),
    addPrivateCollection: vi.fn(pending),
    approve: vi.fn(pending),
    select: vi.fn(pending),
    chooseAnother: vi.fn(pending),
    signOut: vi.fn(pending),
    start: vi.fn(pending),
    assess: vi.fn(pending),
    forget: vi.fn(pending),
    deleteCollection: vi.fn(pending),
    setup: { plan: vi.fn(pending), apply: vi.fn(pending) },
  };
  const set = (next: Partial<MdbaseSnapshot>) => { value = { ...value, ...next }; for (const listener of listeners) listener(); };
  return { mdbase, entry: mdbase as unknown as Mdbase, set };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(() => root.render(node));
const button = (name: string | RegExp) => {
  const found = [...document.querySelectorAll<HTMLElement>("button, [role=radio]")].find((element) =>
    typeof name === "string" ? element.textContent?.trim() === name || element.getAttribute("aria-label") === name : name.test(element.textContent ?? ""));
  if (!found) throw new Error(`no button ${String(name)}`);
  return found;
};
const key = (element: Element, value: string) => act(() => { element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); });

describe("opening presentation", () => {
  it.each(["page", "panel"] as const)("preserves programmatic focus on visible and hidden %s headings", (layout) => {
    const { entry, set } = fakeMdbase({ kind: "starting" }, { status: "starting", signIn: null });
    render(<CollectionGate mdbase={entry} app={app} layout={layout}>{() => null}</CollectionGate>);
    act(() => set({ phase: { kind: "signed_out", notice: null } }));
    const heading = container.querySelector(layout === "page" ? "h1" : "h2")!;
    expect(heading.tabIndex).toBe(-1);
    expect(heading.className).toBe("mdbase-collections-heading");
    expect(document.activeElement).toBe(heading);
    act(() => set({ phase: { kind: "opening", collectionId: A, displayName: "Alpha", slow: false } }));
    expect(heading.className).toBe("mdbase-collections-visually-hidden");
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  });

  it("uses the shared scanning opening screen for starting and keeps embedded landmarks valid", () => {
    const { entry } = fakeMdbase({ kind: "starting" }, { status: "starting", signIn: null });
    render(<main><CollectionGate mdbase={entry} app={app} layout="panel">{() => null}</CollectionGate></main>);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector('[data-loading-state="opening"] .mdbase-motion-scan')).not.toBeNull();
    expect(container.querySelector(".mdbase-collections-spinner")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("TaskNotes");
  });

  it("retains slow-opening copy, account actions and choose-another without a spinner", () => {
    const { entry, set } = fakeMdbase({ kind: "opening", collectionId: A, displayName: "Alpha", slow: false });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    expect(container.querySelector("main")?.textContent).toContain("Opening Alpha");
    act(() => set({ phase: { kind: "opening", collectionId: A, displayName: "Alpha", slow: true } }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("This is taking longer than usual.");
    expect(button("Choose a different collection")).toBeDefined();
    expect(button("Sign out")).toBeDefined();
    expect(container.querySelector(".mdbase-collections-spinner")).toBeNull();
  });
});

describe("sign-out progress", () => {
  it.each(["page", "panel"] as const)("explains a pending sign-out on the signed-out %s screen until the original action settles", async (layout) => {
    const { mdbase, entry, set } = fakeMdbase({ kind: "choosing", lastApproval: null });
    let finish!: (snapshot: MdbaseSnapshot) => void;
    mdbase.signOut.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<CollectionGate mdbase={entry} app={app} layout={layout}>{() => null}</CollectionGate>);
    act(() => button("Sign out").click());
    expect(mdbase.signOut).toHaveBeenCalledOnce();
    expect(button("Signing out…").getAttribute("aria-disabled")).toBe("true");

    // The SDK publishes signed_out after installation erasure, before its
    // original terminal Worker close finishes. That snapshot is not permission
    // for the UI to pretend its outstanding signOut promise has completed.
    act(() => set({ status: "signed_out", phase: { kind: "signed_out", notice: null }, signIn: null, collections: [],
      signOutResult: { server: "revoked", local: "erased", webPush: false } }));
    expect(container.textContent).toContain("You've signed out of TaskNotes on this device.");
    expect(container.textContent).toContain("Signing out…");
    act(() => button("Signing out…").click());
    expect(mdbase.signIn).not.toHaveBeenCalled();
    expect(mdbase.signOut).toHaveBeenCalledOnce();

    await act(async () => { finish(entry.getSnapshot()); });
    expect(container.textContent).not.toContain("Signing out…");
    expect(button("Sign in").getAttribute("aria-disabled")).toBeNull();
    act(() => { button("Sign in").click(); expect(mdbase.signIn).toHaveBeenCalledOnce(); });
  });
});

describe("popup calls run inside the click", () => {
  it("calls signIn before the click handler returns", () => {
    const { mdbase, entry } = fakeMdbase({ kind: "signed_out", notice: null }, { signIn: null, collections: [] });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    // Asserted inside the same synchronous callback as the click: the SDK must already have been called.
    act(() => {
      button("Sign in").click();
      expect(mdbase.signIn).toHaveBeenCalledTimes(1);
    });
  });

  it("adds a collection in the click, or straight from the app's own confirm resolving", async () => {
    const { mdbase, entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    act(() => {
      button("Add a collection…").click();
      expect(mdbase.addCollection).toHaveBeenCalledTimes(1);
    });

    const second = fakeMdbase({ kind: "ready", collectionId: A, collection: { collectionId: A, displayName: "Alpha", role: "owner" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] },
      { status: "ready", selectedCollectionId: A });
    let confirm!: (ok: boolean) => void;
    const onBeforeLeave = vi.fn(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    render(<CollectionSwitcher mdbase={second.entry} app={app} onBeforeLeave={onBeforeLeave} />);
    act(() => button("Switch collection, current: Alpha").click());
    act(() => button(/Add a collection/).click());
    expect(onBeforeLeave).toHaveBeenCalledWith("add");
    expect(second.mdbase.addCollection).not.toHaveBeenCalled();
    await act(async () => {
      confirm(true);
      // The next microtask: no other await may come between the app's confirm and the Connect window.
      await Promise.resolve();
      expect(second.mdbase.addCollection).toHaveBeenCalledTimes(1);
    });
  });
});

describe("SDK storage and Private states", () => {
  it.each((["page", "panel", "switcher"] as const).flatMap((surface) =>
    [undefined, true, false].map((allowPrivate) => ({ surface, allowPrivate }))))("offers one canonical Add on $surface with legacy allowPrivate=$allowPrivate", ({ surface, allowPrivate }) => {
    const { mdbase, entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    if (surface === "switcher") {
      render(<CollectionSwitcher mdbase={entry} app={app} allowPrivate={allowPrivate} />);
      act(() => button("Choose a collection").click());
    } else render(<CollectionGate mdbase={entry} app={app} layout={surface} allowPrivate={allowPrivate}>{() => null}</CollectionGate>);
    const adds = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((element) => element.textContent?.trim() === "Add a collection…");
    expect(adds).toHaveLength(1);
    expect(() => button("Add a Private collection")).toThrow();
    expect(mdbase.addCollection).not.toHaveBeenCalled();
    act(() => {
      adds[0]!.click();
      expect(mdbase.addCollection).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
    });
    expect(mdbase.addPrivateCollection).not.toHaveBeenCalled();
  });

  it("still aborts a legacy tracked private add without claiming it settled early", async () => {
    const { entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const abort = vi.spyOn(AbortController.prototype, "abort");
    function Host() {
      const ui = useCollectionUi({ mdbase: entry, app });
      return <><button onClick={() => { void ui.actions.track("add_private", () => pending); }}>Tracked add</button>
        <output>{ui.busy ?? "idle"}</output><button onClick={ui.actions.cancel}>Cancel add</button></>;
    }
    try {
      render(<Host />);
      act(() => button("Tracked add").click());
      act(() => button("Cancel add").click());
      expect(abort).toHaveBeenCalledOnce();
      expect(abort.mock.contexts[0]!.signal.aborted).toBe(true);
      expect(container.querySelector("output")?.textContent).toBe("add_private");
      await act(async () => { finish(); });
      expect(container.querySelector("output")?.textContent).toBe("idle");
    } finally { abort.mockRestore(); }
  });

  it("keeps the deprecated UI action as normal Add, including leave and cancellation guards", () => {
    const { mdbase, entry } = fakeMdbase({ kind: "ready", collectionId: A, collection: { collectionId: A, displayName: "Alpha", role: "owner" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] });
    const before = vi.fn(() => false);
    function Host() {
      const ui = useCollectionUi({ mdbase: entry, app, onBeforeLeave: before });
      expect(ui.actions.addPrivateCollection).toBe(ui.actions.addCollection);
      return <><button onClick={ui.actions.addPrivateCollection}>Legacy add</button><button onClick={ui.actions.cancel}>Cancel add</button></>;
    }
    render(<Host />);
    act(() => button("Legacy add").click());
    expect(before).toHaveBeenCalledWith("add");
    expect(mdbase.addCollection).not.toHaveBeenCalled();
    before.mockReturnValue(true);
    act(() => {
      button("Legacy add").click();
      expect(mdbase.addCollection).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
    });
    const signal = mdbase.addCollection.mock.calls[0]![0]!.signal!;
    expect(signal.aborted).toBe(false);
    act(() => button("Cancel add").click());
    expect(signal.aborted).toBe(true);
    expect(mdbase.addPrivateCollection).not.toHaveBeenCalled();
  });

  it("uses normal Add in the gesture and renders the SDK computer-approval state", async () => {
    const { mdbase, entry, set } = fakeMdbase({ kind: "choosing", lastApproval: null });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    act(() => {
      button("Add a collection…").click();
      expect(mdbase.addCollection).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
      expect(mdbase.addPrivateCollection).not.toHaveBeenCalled();
    });
    const problem = describeError("device_approval_required")!;
    act(() => set({ phase: { kind: "problem", collectionId: A, problem } }));
    expect(container.textContent).toContain(problem.title);
    expect(container.textContent).toContain(problem.message);
  });

  it("offers normal Add from the ready switcher and obeys the app leave guard", async () => {
    const { mdbase, entry } = fakeMdbase({ kind: "ready", collectionId: A, collection: { collectionId: A, displayName: "Alpha", role: "owner" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] });
    const before = vi.fn(() => false);
    render(<CollectionSwitcher mdbase={entry} app={app} onBeforeLeave={before} />);
    act(() => button("Switch collection, current: Alpha").click());
    act(() => button("Add a collection…").click());
    expect(before).toHaveBeenCalledWith("add");
    expect(mdbase.addCollection).not.toHaveBeenCalled();
    expect(mdbase.addPrivateCollection).not.toHaveBeenCalled();
    render(<CollectionSwitcher mdbase={entry} app={app} />);
    act(() => button("Switch collection, current: Alpha").click());
    act(() => button("Add a collection…").click());
    expect(mdbase.addCollection).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
    expect(mdbase.addPrivateCollection).not.toHaveBeenCalled();
  });

  it("shows only the SDK save warning and removes it on confirmation", () => {
    const { entry, set } = fakeMdbase({ kind: "ready", collectionId: A, collection: { collectionId: A, displayName: "Alpha", role: "owner" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] }, { saveWarning: null });
    render(<CollectionGate mdbase={entry} app={app}>{() => <CollectionSaveWarning />}</CollectionGate>);
    expect(container.querySelector(".mdbase-collections-save-warning")).toBeNull();
    act(() => set({ saveWarning: "storage_may_be_evicted" }));
    expect(container.querySelector(".mdbase-collections-save-warning")?.textContent).toBe(describeError("storage_may_be_evicted")?.message);
    act(() => set({ saveWarning: null }));
    expect(container.querySelector(".mdbase-collections-save-warning")).toBeNull();
  });

  it.each(["browser_unsupported", "application_storage_unavailable"])("renders SDK unavailable copy for %s", (code) => {
    const problem = describeError(code)!;
    const { entry } = fakeMdbase({ kind: "unavailable", problem }, { signIn: null });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    expect(container.textContent).toContain(problem.title);
    expect(container.textContent).toContain(problem.message);
  });

  it("clears the cancellation notice when the SDK reports a successful later add", () => {
    const { entry, set } = fakeMdbase({ kind: "choosing", lastApproval: { kind: "add", outcome: "closed", collectionId: null } });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    expect(container.textContent).toContain("No collection was added.");
    act(() => set({ phase: { kind: "choosing", lastApproval: { kind: "add", outcome: "added", collectionId: A } } }));
    expect(container.textContent).not.toContain("No collection was added.");
  });
});

describe("setup review", () => {
  it("plans again by itself while setup is busy elsewhere, instead of stopping at Try again", async () => {
    vi.useFakeTimers();
    try {
      const { mdbase, entry } = fakeMdbase({ kind: "needs_setup", collectionId: A, collection: { collectionId: A, displayName: "Alpha", role: "owner" } } as MdbasePhase, { status: "setup_required", selectedCollectionId: A });
      const plan = { status: "setup", canApply: true, digest: "d", summary: "This app will make 1 change to this collection.", changes: [{ kind: "create", target: "_types/task.md", message: "Add the task type." }],
        conflicts: [], adoptable: {}, packs: [], staged: [], records: [] };
      // Another tab is finishing setup: the SDK reports a transient busy first.
      mdbase.setup.plan.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "unavailable", reason: "configuration_busy" })).mockResolvedValue(plan as never);
      render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
      await act(async () => { await Promise.resolve(); });
      expect(() => button("Try again")).toThrow();
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(mdbase.setup.plan).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Add the task type.");
      expect(() => button("Try again")).toThrow();
    } finally { vi.useRealTimers(); }
  });
});

describe("blocked screen", () => {
  it("shows the problem with its fix inside, collections never as actions, and navigation in the footer", () => {
    const { mdbase, entry } = fakeMdbase({
      kind: "problem", collectionId: A,
      problem: { key: "access_removed", title: "You no longer have access", message: "You were removed from this collection.", action: "approve", actionLabel: "Approve", retryAfterMs: null, updateUrl: null, severity: "warning", transient: false, code: "forbidden", developerMessage: "internal detail" },
    }, { status: "blocked", selectedCollectionId: A, collections: [{ collectionId: A, displayName: "[test] A collection with a long name", role: "owner" }] });
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);

    expect(container.querySelector("h1")?.textContent).toBe("Can't open [test] A collection with a long name");
    const alert = container.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("You no longer have access");
    expect(alert.querySelector("button")?.textContent).toBe("Approve");
    expect(container.textContent).not.toMatch(/Welcome back|Other collections|internal detail/);
    expect(container.querySelector(".mdbase-collections-list")).toBeNull();
    const footer = container.querySelector("footer")!;
    expect(alert.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer.textContent).toContain("Choose a different collection");
    expect(footer.textContent).toContain("Signed in as ada@example.com");

    act(() => alert.querySelector("button")!.click());
    expect(mdbase.approve).toHaveBeenCalledWith(A, expect.anything());
  });
});

describe("switcher keyboard", () => {
  it("opens on the current collection, moves with arrows, switches on Enter-click and closes on Escape", () => {
    const { mdbase, entry } = fakeMdbase({ kind: "ready", collectionId: B, collection: { collectionId: B, displayName: "Beta", role: "editor" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] },
      { status: "ready", selectedCollectionId: B });
    render(<CollectionSwitcher mdbase={entry} app={app} />);
    const trigger = button("Switch collection, current: Beta");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Collections");
    const radios = [...document.querySelectorAll<HTMLElement>("[role=radio]")];
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(radios[0]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    key(radios[0]!, "ArrowDown");
    expect(document.activeElement).toBe(radios[1]);
    key(radios[1]!, "End");
    expect(document.activeElement).toBe(radios[2]);
    key(radios[2]!, "ArrowDown");
    expect(document.activeElement).toBe(radios[0]);

    key(document.activeElement!, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    act(() => button(/Gamma/).click());
    expect(mdbase.select).toHaveBeenCalledWith(C, expect.anything());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Private collections", () => {
  it("marks a Private row, visibly and in its accessible name, in the switcher and the chooser", () => {
    const P = "44444444-4444-4444-8444-444444444444";
    const collections = [
      { collectionId: A, displayName: "Alpha", role: "owner" },
      { collectionId: P, displayName: "Home notes", role: "owner", kind: "private" },
    ];
    const ready = { kind: "ready", collectionId: P, collection: collections[1], connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] } as unknown as MdbasePhase;
    const { entry } = fakeMdbase(ready, { status: "ready", selectedCollectionId: P, collections } as unknown as Partial<MdbaseSnapshot>);
    render(<CollectionSwitcher mdbase={entry} app={app} />);
    act(() => button("Switch collection, current: Home notes").click());
    const [privateRow, hostedRow] = [...document.querySelectorAll<HTMLElement>("[role=radio]")];
    // The word is text in the radio (its accessible name), not hidden and not colour alone.
    expect(privateRow!.querySelector(".mdbase-collections-row-name")?.textContent).toBe("Home notes Private");
    expect(privateRow!.querySelector(".mdbase-collections-private")?.closest("[aria-hidden]")).toBeNull();
    expect(privateRow!.querySelector(".mdbase-collections-private svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(hostedRow!.querySelector(".mdbase-collections-row-name")?.textContent).toBe("Alpha");
    expect(hostedRow!.textContent).not.toContain("Private");
    expect(document.querySelector(".mdbase-collections-switcher-current")?.textContent).toContain("Private");

    act(() => root.unmount());
    root = createRoot(container);
    const choosing = fakeMdbase({ kind: "choosing", lastApproval: null } as unknown as MdbasePhase, { collections } as unknown as Partial<MdbaseSnapshot>);
    render(<CollectionGate mdbase={choosing.entry} app={app}>{() => null}</CollectionGate>);
    expect(button(/Home notes/).textContent).toContain("Private");
    expect(button(/Alpha/).textContent).not.toContain("Private");
  });
});

describe("sign out", () => {
  it("asks before losing unsaved changes, with the SDK's copy", async () => {
    const { mdbase, entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    mdbase.signOut.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("pending"), { code: "conflict", reason: "sign_out_pending_writes" })));
    render(<CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>);
    await act(async () => { button("Sign out").click(); });
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Changes are still saving");
    act(() => button("Sign out anyway").click());
    expect(mdbase.signOut).toHaveBeenLastCalledWith(expect.objectContaining({ discard: true }));
  });
});

describe("auto start", () => {
  it("starts a front door that hasn't started, once across gates, and not when off or already started", () => {
    const { mdbase, entry } = fakeMdbase({ kind: "starting" }, { status: "not_started", signIn: null });
    render(<StrictMode>
      <CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>
      <CollectionGate mdbase={entry} app={app}>{() => null}</CollectionGate>
    </StrictMode>);
    expect(mdbase.start).toHaveBeenCalledTimes(1);

    const off = fakeMdbase({ kind: "starting" }, { status: "not_started", signIn: null });
    render(<CollectionGate mdbase={off.entry} app={app} autoStart={false}>{() => null}</CollectionGate>);
    const started = fakeMdbase({ kind: "choosing", lastApproval: null });
    render(<CollectionGate mdbase={started.entry} app={app}>{() => null}</CollectionGate>);
    expect(off.mdbase.start).not.toHaveBeenCalled();
    expect(started.mdbase.start).not.toHaveBeenCalled();
  });
});

describe("delete outcome", () => {
  function Host({ entry, onClose }: { entry: Mdbase; onClose: (outcome: DeleteCollectionOutcome) => void }) {
    const ui = useCollectionUi({ mdbase: entry, app });
    return <DeleteCollectionDialog ui={ui} collection={{ id: A, name: "Alpha" }} onClose={onClose} />;
  }
  const typeName = () => act(() => {
    const input = document.querySelector<HTMLInputElement>("dialog input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Alpha");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("reports failed after a refused delete, and deleted after one that worked", async () => {
    const { mdbase, entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    const onClose = vi.fn();
    mdbase.deleteCollection.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("no"), { code: "forbidden" })));
    render(<Host entry={entry} onClose={onClose} />);
    typeName();
    await act(async () => { button("Delete collection").click(); });
    act(() => button("Cancel").click());
    expect(onClose).toHaveBeenLastCalledWith("failed");

    mdbase.deleteCollection.mockImplementationOnce(() => Promise.resolve(entry.getSnapshot()));
    render(<Host key="again" entry={entry} onClose={onClose} />);
    typeName();
    await act(async () => { button("Delete collection").click(); });
    expect(onClose).toHaveBeenLastCalledWith("deleted");
  });
});

describe("app slots", () => {
  const privateSection = (onSelect = vi.fn(), onClose = vi.fn(), current = false): CollectionSection => ({
    id: "private", title: "Private collections", onSelect, onClose,
    items: [{ id: "p1", name: "Journal", detail: "On this device", current }],
  });

  it("puts app actions in the footer on every screen but signed out, and lists app sections", () => {
    const { entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    const onSelect = vi.fn();
    render(<CollectionGate mdbase={entry} app={app} extraActions={(view) => <a href="#help">Help for {view.kind}</a>} sections={[privateSection(onSelect)]}>{() => null}</CollectionGate>);
    expect(container.querySelector("footer")?.textContent).toContain("Help for choosing");
    const section = container.querySelector("[data-section=private]")!;
    expect(section.querySelector("h2")?.textContent).toBe("Private collections");
    expect(section.textContent).toContain("On this device");
    act(() => button(/Journal/).click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });

  it("renders an open app collection in place of the gate, with a way back to the list", () => {
    const { mdbase, entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    const onClose = vi.fn();
    let back!: () => void;
    render(<CollectionGate mdbase={entry} app={app} sections={[privateSection(vi.fn(), onClose, true)]}
      renderAppCollection={(item, context) => { back = context.chooseAnother; return <p id="app">{item.name} open</p>; }}>{() => null}</CollectionGate>);
    expect(container.querySelector("#app")?.textContent).toBe("Journal open");
    expect(container.querySelector(".mdbase-collections-gate")).toBeNull();
    act(() => back());
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(mdbase.chooseAnother).not.toHaveBeenCalled();
  });

  it("shows app sections, row details and the collection's mark in the switcher", () => {
    const { mdbase, entry } = fakeMdbase({ kind: "ready", collectionId: B, collection: { collectionId: B, displayName: "Beta", role: "editor" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] },
      { status: "ready", selectedCollectionId: B });
    const onSelect = vi.fn();
    render(<CollectionSwitcher mdbase={entry} app={app} icon="mark" sections={[privateSection(onSelect)]} rowDetail={(row) => `Detail ${row.entry.collectionId.slice(0, 2)}`} />);
    const trigger = button("Switch collection, current: Beta");
    expect(trigger.querySelector(".mdbase-collections-mark")?.textContent).toBe("B");
    act(() => trigger.click());
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Detail 22");
    const groups = [...document.querySelectorAll("[role=radiogroup]")];
    expect(groups.map((group) => group.getAttribute("aria-labelledby") && document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent))
      .toEqual(["Your collections", "Private collections"]);
    act(() => button(/Journal/).click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(mdbase.select).not.toHaveBeenCalled();
  });
});

describe("section item actions", () => {
  const withActions = (rename = vi.fn(), onDeleted = vi.fn()): CollectionSection => ({
    id: "private", title: "Private collections", onSelect: vi.fn(),
    items: [{ id: "p1", name: "Journal", actions: [
      { id: "rename", label: "Rename…", onSelect: rename },
      { id: "archive", label: "Archive", onSelect: vi.fn(), disabled: true },
      { id: "delete", label: "Delete collection…", danger: true, onSelect: (_item, { confirmDelete }) => confirmDelete(onDeleted) },
    ] }],
  });

  it("shows the row menu with roles, moves by keyboard and returns focus on Escape", () => {
    const { entry } = fakeMdbase({ kind: "choosing", lastApproval: null });
    const rename = vi.fn();
    render(<CollectionGate mdbase={entry} app={app} sections={[withActions(rename)]}>{() => null}</CollectionGate>);
    const more = button("More for Journal");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")];
    expect(items.map((item) => item.textContent)).toEqual(["Rename…", "Archive", "Delete collection…"]);
    expect(items.map((item) => item.classList.contains("is-danger"))).toEqual([false, false, true]);
    expect(items[1]!.disabled).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, "ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    key(document.activeElement!, "Escape");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);

    act(() => more.click());
    act(() => button("Rename…").click());
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), expect.anything());
    expect(document.activeElement).toBe(more);
  });

  it("reaches the menu from a switcher row with ArrowRight, and a danger action asks before deleting", async () => {
    const { mdbase, entry } = fakeMdbase({ kind: "ready", collectionId: B, collection: { collectionId: B, displayName: "Beta", role: "editor" }, connection: {} as never, rechecking: false, problem: null, unavailableTypes: [] },
      { status: "ready", selectedCollectionId: B });
    const onDeleted = vi.fn();
    render(<CollectionSwitcher mdbase={entry} app={app} sections={[withActions(vi.fn(), onDeleted)]} />);
    act(() => button("Switch collection, current: Beta").click());
    const row = button(/Journal/);
    key(row, "ArrowRight");
    expect(document.activeElement).toBe(button("More for Journal"));
    act(() => button("More for Journal").click());
    act(() => button("Delete collection…").click());

    expect(mdbase.deleteCollection).not.toHaveBeenCalled();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Delete Journal?");
    mdbase.deleteCollection.mockImplementationOnce(() => Promise.resolve(entry.getSnapshot()));
    act(() => {
      const input = dialog.querySelector<HTMLInputElement>("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Journal");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Delete collection").click(); });
    expect(mdbase.deleteCollection).toHaveBeenCalledWith("p1", { confirmName: "Journal" });
    expect(onDeleted).toHaveBeenCalledWith("deleted");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(button("Switch collection, current: Beta"));
  });
});

describe("styles", () => {
  it("suppresses only noninteractive heading outlines and retains control focus-visible rings", () => {
    const css = readFileSync(join(import.meta.dirname, "../../css/collections.css"), "utf8");
    expect(css).toMatch(/:is\(h1, h2\)\.mdbase-collections-heading\[tabindex="-1"\]:focus,\s*:is\(h1, h2\)\.mdbase-collections-visually-hidden\[tabindex="-1"\]:focus\s*\{\s*outline: none;/);
    expect(css).not.toMatch(/\.mdbase-collections-heading:focus-visible/);
    expect(css).toMatch(/\.mdbase-collections-button:focus-visible,[\s\S]*?\.mdbase-collections-field:focus-visible\s*\{\s*outline: 2px solid var\(--_accent\);/);
  });

  it("defines every collections class the components use", () => {
    const css = readFileSync(join(import.meta.dirname, "../../css/collections.css"), "utf8");
    const used = new Set<string>();
    for (const file of readdirSync(import.meta.dirname).filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))) {
      for (const match of readFileSync(join(import.meta.dirname, file), "utf8").matchAll(/mdbase-collections-[a-z-]+/g)) used.add(match[0]);
    }
    const missing = [...used].filter((name) => name !== "mdbase-collections-hue" && !css.includes(`.${name}`));
    expect(missing).toEqual([]);
  });
});
