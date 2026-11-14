// @vitest-environment jsdom
import "../../test/dialog.js";
import type { Mdbase, MdbasePhase, MdbaseSnapshot } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionGate, CollectionPanel, useUnsyncedSavedLabel } from "../collections.js";
import { collectionView } from "./model.js";
import { planNeedsReview, unsyncedApi, type UnsyncedResult } from "./unsynced.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "99999999-9999-4999-8999-999999999999";
const app = { name: "TaskNotes" };
const unsyncedPhase = { kind: "unsynced", collectionId: U, connection: {}, rechecking: false } as unknown as MdbasePhase;
const readyPhase = { kind: "ready", collectionId: A, collection: { collectionId: A, displayName: "Alpha", role: "owner" }, connection: {} as never,
  rechecking: false, problem: null, unavailableTypes: [] } as MdbasePhase;
const work = { unsyncedWork: { collectionId: U, since: "2026-11-01T00:00:00.000Z" } } as unknown as Partial<MdbaseSnapshot>;
const plan = (extra: object = {}) => ({ source: U, destination: A, items: [], missingTypes: [], addTypes: [], counts: { create: 2, present: 0, skipped: 0, renamed: 0 }, ...extra });

function fakeMdbase(phase: MdbasePhase, extra: Partial<MdbaseSnapshot> = {}, signedIn = true) {
  let value = {
    status: "unselected",
    signIn: signedIn ? { state: "paired", accountEmail: "ada@example.com" } : null,
    collections: signedIn ? [{ collectionId: A, displayName: "Alpha", role: "owner" }] : [],
    selectedCollectionId: null, problem: null, timing: null,
    readiness: { checking: false, assessment: null, problem: null, facets: {} },
    selection: { state: "none", problem: null, usable: null, requested: { collectionId: null, source: "none", displayName: null, approved: false } },
    phase, sync: null, unsyncedWork: null,
    links: { account: "https://connect.example/account", manageAccess: "https://connect.example/account/applications" },
    ...extra,
  } as unknown as MdbaseSnapshot;
  const listeners = new Set<() => void>();
  const pending = () => new Promise<MdbaseSnapshot>(() => {});
  const set = (next: Partial<MdbaseSnapshot>) => { value = { ...value, ...next }; for (const listener of listeners) listener(); };
  const mdbase = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    signIn: vi.fn(pending), addCollection: vi.fn(pending), approve: vi.fn(pending), select: vi.fn(pending), chooseAnother: vi.fn(pending),
    signOut: vi.fn(pending), start: vi.fn(pending), assess: vi.fn(pending), forget: vi.fn(pending), deleteCollection: vi.fn(pending),
    setup: { plan: vi.fn(pending), apply: vi.fn(pending) },
    unsynced: {
      open: vi.fn(async () => value),
      planTransfer: vi.fn(async (_options?: object) => plan()),
      transfer: vi.fn(async (_plan: object, _options?: object): Promise<UnsyncedResult> => { set({ unsyncedWork: null } as never); return { failed: [], failedTypes: [], retired: true }; }),
      discard: vi.fn(async () => { set({ unsyncedWork: null } as never); return value; }),
    },
  };
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

const render = (node: ReactNode) => act(async () => root.render(node));
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string, scope: ParentNode = document) => {
  const found = buttons(scope).find((element) => element.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
const click = (element: HTMLElement) => act(async () => element.click());

describe("model", () => {
  it("reads the unsynced phase and the work marker structurally", () => {
    const { entry } = fakeMdbase(unsyncedPhase, work);
    const view = collectionView(entry.getSnapshot(), { appName: app.name });
    expect(view).toMatchObject({ kind: "unsynced", collectionId: U, unsyncedWork: true, heading: app.name });
    expect(collectionView(fakeMdbase(readyPhase).entry.getSnapshot(), { appName: app.name })).toMatchObject({ kind: "ready", unsyncedWork: false });
  });

  it("finds the API only when all of it is there, and asks first only for renames or types", () => {
    expect(unsyncedApi(fakeMdbase(unsyncedPhase).entry)).not.toBeNull();
    expect(unsyncedApi({ unsynced: { open: () => {} } } as unknown as Mdbase)).toBeNull();
    expect(unsyncedApi({} as Mdbase)).toBeNull();
    expect(planNeedsReview(plan())).toBe(false);
    expect(planNeedsReview(plan({ counts: { create: 1, present: 0, skipped: 0, renamed: 1 } }))).toBe(true);
    expect(planNeedsReview(plan({ addTypes: ["task"] }))).toBe(true);
    expect(planNeedsReview(plan({ missingTypes: ["idea"] }))).toBe(true);
  });
});

describe("working before connecting", () => {
  it("offers Continue without connecting on the signed-out screen only when the app opts in", async () => {
    const signedOut = { kind: "signed_out", notice: null } as MdbasePhase;
    const { mdbase, entry } = fakeMdbase(signedOut, {}, false);
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false}>{() => null}</CollectionGate>);
    expect(() => button("Continue without connecting")).toThrow();
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    await click(button("Continue without connecting"));
    expect(mdbase.unsynced.open).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("renders the app in the unsynced collection, with the quiet line only once something is saved", async () => {
    const { mdbase, entry, set } = fakeMdbase(unsyncedPhase, {}, false);
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced={{ storage: "device" }}>{() => <p id="app">app</p>}</CollectionGate>);
    expect(container.querySelector("#app")).not.toBeNull();
    expect(container.querySelector(".mdbase-collections-unsynced")).toBeNull();
    await act(async () => set(work));
    expect(container.querySelector(".mdbase-collections-unsynced-status")?.textContent).toBe("Saved only on this device");
    await click(button("Connect to sync your work"));
    expect(mdbase.signIn).toHaveBeenCalled();
    expect(mdbase.addCollection).not.toHaveBeenCalled();
  });

  it("connects a signed-in person by adding a collection", async () => {
    const { mdbase, entry } = fakeMdbase(unsyncedPhase, work);
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    expect(container.querySelector(".mdbase-collections-unsynced-status")?.textContent).toBe("Saved only in this browser");
    await click(button("Connect to sync your work"));
    expect(mdbase.addCollection).toHaveBeenCalled();
    expect(mdbase.signIn).not.toHaveBeenCalled();
  });

  it("says where the work is kept in the app's own save notice, and nothing once a collection is open", async () => {
    const { entry, set } = fakeMdbase(unsyncedPhase);
    let label: string | null = "unset";
    function Notice() { label = useUnsyncedSavedLabel(); return null; }
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => <Notice />}</CollectionGate>);
    expect(label).toBe("Saved only in this browser");
    await act(async () => set({ phase: readyPhase }));
    expect(label).toBeNull();
  });

  it("checks a settled unsynced setup problem again and offers signing in instead", async () => {
    const problem = describeError("contract_missing")!;
    const shown = { status: "setup_required", selectedCollectionId: U, unsynced: { collectionId: U, sessionStatus: "signed_out" } } as unknown as Partial<MdbaseSnapshot>;
    const { mdbase, entry } = fakeMdbase({ kind: "problem", collectionId: U, problem } as MdbasePhase, shown, false);
    const view = collectionView(entry.getSnapshot(), { appName: app.name });
    expect(view.kind === "problem" && view.unsynced).toBe(true);
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    // Never a setup review: the unsynced collection sets itself up when it opens.
    expect(() => button(problem.actionLabel!)).toThrow();
    await click(button("Try again"));
    expect(mdbase.assess).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mdbase.setup.plan).not.toHaveBeenCalled();
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced key="again">{() => null}</CollectionGate>);
    await click(button("Sign in"));
    expect(mdbase.signIn).toHaveBeenCalled();
  });

  it("leaves another collection's setup problem as it was", () => {
    const problem = describeError("contract_missing")!;
    const { entry } = fakeMdbase({ kind: "problem", collectionId: A, problem } as MdbasePhase,
      { status: "setup_required", selectedCollectionId: A } as Partial<MdbaseSnapshot>);
    const view = collectionView(entry.getSnapshot(), { appName: app.name });
    expect(view.kind === "problem" && { unsynced: view.unsynced, control: view.notice.control?.kind }).toEqual({ unsynced: false, control: "set_up" });
  });

  it("shows where the work is kept in a settings panel", async () => {
    const { mdbase, entry } = fakeMdbase(unsyncedPhase, {}, false);
    await render(<CollectionPanel mdbase={entry} app={app} autoStart={false} unsynced />);
    expect(container.textContent).toContain("Saved only in this browser");
    await click(button("Connect to sync your work"));
    expect(mdbase.signIn).toHaveBeenCalled();
  });
});

describe("bringing work in", () => {
  it("offers nothing without unsynced work", async () => {
    const { entry } = fakeMdbase(readyPhase);
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    expect(() => button("Bring it in")).toThrow();
  });

  it("brings it straight in when nothing changes, with the app's map and the destination's types added, then says so", async () => {
    const { mdbase, entry } = fakeMdbase(readyPhase, work);
    const map = vi.fn();
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced={{ map }}>{() => null}</CollectionGate>);
    expect(container.textContent).toContain("You have work that isn't in Alpha yet.");
    await click(button("Bring it in"));
    expect(mdbase.unsynced.planTransfer).toHaveBeenCalledWith(expect.objectContaining({ map, addTypes: true }));
    expect(mdbase.unsynced.transfer).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toContain("Your work is now in Alpha.");
    expect(() => button("Bring it in")).toThrow();
    await click(button("Close"));
    expect(container.textContent).not.toContain("Your work is now in Alpha.");
  });

  it("asks first when names or types change, and transfers that same plan only on confirmation", async () => {
    const { mdbase, entry } = fakeMdbase(readyPhase, work);
    const reviewed = plan({ addTypes: ["task"], missingTypes: ["idea"], counts: { create: 2, present: 0, skipped: 0, renamed: 1 } });
    mdbase.unsynced.planTransfer.mockResolvedValueOnce(reviewed).mockResolvedValueOnce(reviewed);
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    await click(button("Bring it in"));
    expect(mdbase.unsynced.transfer).not.toHaveBeenCalled();
    const open = dialog()!;
    expect(open.textContent).toContain("Bring your work into Alpha?");
    expect(open.textContent).toContain("Some items get a new name because their names are already taken.");
    expect(open.textContent).toContain("These types are added: task.");
    expect(open.textContent).toContain("Some items use types this collection doesn't have.");
    await click(button("Cancel", open));
    expect(dialog()).toBeNull();
    expect(mdbase.unsynced.transfer).not.toHaveBeenCalled();
    await click(button("Bring it in"));
    await click(button("Bring it in", dialog()!));
    expect(mdbase.unsynced.transfer).toHaveBeenCalledWith(reviewed, expect.anything());
  });

  it("offers Bring it in again after a partial failure, while the work is still there", async () => {
    const { mdbase, entry } = fakeMdbase(readyPhase, work);
    mdbase.unsynced.transfer.mockResolvedValueOnce({ failed: [{ sourceId: "x", code: "unavailable" }], failedTypes: [], retired: false });
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    await click(button("Bring it in"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Some of your work couldn't be brought in. Try again.");
    await click(button("Bring it in"));
    expect(mdbase.unsynced.transfer).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Your work is now in Alpha.");
  });

  it("keeps the outcome with the collection the work went into, and asks again when work stays open elsewhere", async () => {
    const { mdbase, entry, set } = fakeMdbase(readyPhase, work);
    mdbase.unsynced.transfer.mockResolvedValueOnce({ failed: [], failedTypes: [], retired: false });
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    await click(button("Bring it in"));
    expect(container.textContent).toContain("Your work is now in Alpha. If it's still open in another tab, close it there, then bring it in again.");
    expect(button("Bring it in")).toBeDefined();
    const beta = { kind: "ready", collectionId: B, collection: { collectionId: B, displayName: "Beta", role: "owner" }, connection: {} as never,
      rechecking: false, problem: null, unavailableTypes: [] } as MdbasePhase;
    await act(async () => set({ phase: beta, collections: [...entry.getSnapshot().collections, { collectionId: B, displayName: "Beta", role: "owner" }] as never }));
    expect(container.textContent).not.toContain("Your work is now in Alpha");
    expect(container.textContent).toContain("You have work that isn't in Beta yet.");
  });

  it("shows why bringing work in or discarding it was refused", async () => {
    const { mdbase, entry } = fakeMdbase(readyPhase, work);
    mdbase.unsynced.planTransfer.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "unavailable" }));
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    await click(button("Bring it in"));
    expect(container.querySelectorAll(".mdbase-collections-notice").length).toBeGreaterThan(1);
    expect(button("Bring it in")).toBeDefined();
  });

  it("names items changed since they were brought in before bringing them in again", async () => {
    const { mdbase, entry } = fakeMdbase(readyPhase, work);
    mdbase.unsynced.planTransfer.mockResolvedValueOnce(plan({ counts: { create: 0, present: 2, skipped: 0, renamed: 0, changed: 1 } }));
    await render(<CollectionGate mdbase={entry} app={app} autoStart={false} unsynced>{() => null}</CollectionGate>);
    await click(button("Bring it in"));
    expect(dialog()!.textContent).toContain("Some items changed after they were brought in. Their newer versions are added beside them.");
    expect(dialog()!.textContent).not.toContain("get a new name");
  });

  it("discards only after the person confirms, naming the app", async () => {
    const { mdbase, entry } = fakeMdbase(readyPhase, work);
    await render(<CollectionPanel mdbase={entry} app={app} autoStart={false} unsynced />);
    await click(button("Discard…"));
    const open = dialog()!;
    expect(open.textContent).toContain("Discard work that isn't in a collection?");
    expect(open.textContent).toContain("It's erased from TaskNotes on this device. This can't be undone.");
    await click(button("Cancel", open));
    expect(mdbase.unsynced.discard).not.toHaveBeenCalled();
    await click(button("Discard…"));
    await click(button("Discard", dialog()!));
    expect(mdbase.unsynced.discard).toHaveBeenCalledTimes(1);
    expect(() => button("Bring it in")).toThrow();
  });
});
