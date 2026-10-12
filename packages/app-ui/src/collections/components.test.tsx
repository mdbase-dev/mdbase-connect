// @vitest-environment jsdom
import type { Mdbase, MdbasePhase, MdbaseSnapshot } from "@mdbase-dev/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionGate, CollectionSwitcher } from "../collections.js";

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
    addCollection: vi.fn(pending),
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

describe("styles", () => {
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
