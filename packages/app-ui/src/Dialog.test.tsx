// @vitest-environment jsdom
import "../test/dialog.js";
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { MdbaseMark } from "./brand.js";
import { CommandPalette } from "./CommandPalette.js";
import { Dialog } from "./Dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); vi.useRealTimers(); vi.restoreAllMocks(); });

it("releases modal ownership immediately while its visual exit is inert", async () => {
  let finish!: () => void;
  vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([{ finished: new Promise<void>(resolve => { finish = resolve; }) }] as Animation[]);
  const draw = (open: boolean) => <><button data-invoker>Open</button><Dialog open={open} title="Details" onClose={vi.fn()}><input data-autofocus /></Dialog></>;
  await act(async () => root.render(draw(false)));
  const invoker = host.querySelector<HTMLButtonElement>("[data-invoker]")!;
  invoker.focus();
  await act(async () => root.render(draw(true)));
  const dialog = document.querySelector("dialog")!;
  await act(async () => root.render(draw(false)));
  expect(document.querySelector("dialog")).toBe(dialog);
  expect(dialog.open).toBe(false);
  expect(dialog.hasAttribute("inert")).toBe(true);
  expect(dialog.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(invoker);
  await act(async () => finish());
  expect(document.querySelector("dialog")).toBeNull();
});

it("prevents backdrop mousedown from moving focus but leaves content mousedown alone", async () => {
  await act(async () => root.render(<Dialog open title="Details" onClose={vi.fn()}><input data-autofocus /></Dialog>));
  const input = document.querySelector("input")!;
  const dialog = document.querySelector("dialog")!;
  const backdrop = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  const content = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  dialog.dispatchEvent(backdrop);
  input.dispatchEvent(content);
  expect(backdrop.defaultPrevented).toBe(true);
  expect(content.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);
});

it("focuses a typed confirmation before its default cancel action", () => {
  act(() => root.render(<ConfirmDialog open title="Delete collection" confirmLabel="Delete" pendingLabel="Deleting…" disabled onConfirm={vi.fn()} onClose={vi.fn()}>
    <label>Type Notes to confirm<input data-autofocus /></label>
  </ConfirmDialog>));
  expect(document.activeElement).toBe(document.querySelector("input"));
  expect(document.querySelector<HTMLButtonElement>(".mdbase-button.is-danger")?.disabled).toBe(true);
});

it("keeps an inspector open beneath quick open and returns focus to it", () => {
  const inspectorClose = vi.fn();
  const openPalette = (open: boolean) => <><Dialog open title="Properties" onClose={inspectorClose}><button data-autofocus>Property</button></Dialog>
    <CommandPalette open={open} commands={[]} onClose={vi.fn()} /></>;
  act(() => root.render(openPalette(false)));
  const invoker = document.activeElement;
  act(() => root.render(openPalette(true)));
  expect(document.querySelectorAll("dialog[open]")).toHaveLength(2);
  expect(inspectorClose).not.toHaveBeenCalled();
  act(() => root.render(openPalette(false)));
  expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
  expect(document.activeElement).toBe(invoker);
});

it("uses ranked results, highlighted content and Home/End in the shared palette", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const run = vi.fn();
  const results = vi.fn(() => Array.from({ length: 20 }, (_, index) => ({
    id: `note-${index}`, label: `Note ${index}`, group: "Notes", content: <strong><mark>Note</mark> {index}</strong>, run
  })));
  act(() => root.render(<CommandPalette open commands={[]} initialQuery=">" getResults={results} onClose={vi.fn()} />));
  const input = document.querySelector("input")!;
  expect(input.value).toBe(">");
  expect(results).toHaveBeenCalledWith(">");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("Note 19");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.querySelector("mark")?.textContent).toBe("Note");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(run).toHaveBeenCalledOnce();
});

it("closes a palette before running its action and does not steal the action's focus", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  let openPalette: () => void;
  function Host() {
    const [open, setOpen] = useState(false);
    openPalette = () => setOpen(true);
    return <><button data-invoker>Search</button><button data-target>Rename</button>
      <CommandPalette open={open} onClose={() => setOpen(false)} returnFocusRef={{ current: host.querySelector<HTMLElement>("[data-invoker]") }} commands={[{
        id: "rename", label: "Rename", group: "actions", run: () => {
          expect(document.querySelector("dialog")?.open).toBe(false);
          host.querySelector<HTMLButtonElement>("[data-target]")!.focus();
        }
      }]} /></>;
  }
  act(() => root.render(<Host />));
  host.querySelector<HTMLButtonElement>("[data-invoker]")!.focus();
  act(() => openPalette!());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("[data-target]"));
});

it("returns focus and app shortcuts as soon as a palette command closes it", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([{ finished: new Promise<void>(() => {}) }] as Animation[]);
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  let openPalette: () => void;
  function Host() {
    const [open, setOpen] = useState(false);
    openPalette = () => setOpen(true);
    return <><button data-invoker>Search</button>
      <CommandPalette open={open} onClose={() => setOpen(false)} commands={[{ id: "beside", label: "Open beside", group: "actions", run: () => {} }]} /></>;
  }
  act(() => root.render(<Host />));
  const invoker = host.querySelector<HTMLButtonElement>("[data-invoker]")!;
  invoker.focus();
  act(() => openPalette!());
  const input = document.querySelector("dialog input")!;
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
  expect(shortcut).not.toHaveBeenCalled();
  act(() => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(document.querySelector("dialog")).not.toBeNull();
  expect(document.activeElement).toBe(invoker);
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
  expect(shortcut).toHaveBeenCalledOnce();
  window.removeEventListener("keydown", shortcut);
});

it("focuses Cancel, keeps the dialog through exit, reverses, and returns focus", async () => {
  let finish!: () => void;
  const animations = vi.spyOn(HTMLElement.prototype, "getAnimations");
  animations.mockReturnValue([{ finished: new Promise<void>(resolve => { finish = resolve; }) }] as Animation[]);
  let changeOpen: (open: boolean) => void;
  function Host() {
    const [open, setOpen] = useState(false);
    changeOpen = setOpen;
    return <><button onClick={() => setOpen(true)}>Delete collection</button>
      <ConfirmDialog open={open} title="Delete Field notes" consequence="The hosted data will be deleted."
        confirmLabel="Delete" pendingLabel="Deleting…" onConfirm={vi.fn()} onClose={() => setOpen(false)} />
    </>;
  }
  act(() => root.render(<Host />));
  const trigger = host.querySelector("button")!;
  trigger.focus();
  act(() => trigger.click());
  const dialog = document.querySelector("dialog")!;
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("The hosted data will be deleted.");
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(dialog.parentElement).toBe(document.body);
  act(() => changeOpen!(false));
  expect(document.querySelector("dialog")).toBe(dialog);
  act(() => changeOpen!(true));
  await act(async () => finish());
  expect(document.querySelector("dialog")).toBe(dialog);
  animations.mockReturnValue([{ finished: new Promise<void>(resolve => { finish = resolve; }) }] as Animation[]);
  act(() => changeOpen!(false));
  expect(document.querySelector("dialog")).toBe(dialog);
  await act(async () => finish());
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps a pending confirmation modal and labels its work", async () => {
  const close = vi.fn();
  let resolve: () => void;
  const pending = new Promise<void>(complete => { resolve = complete; });
  act(() => root.render(<ConfirmDialog open title="Revoke Reader" consequence="Reader will lose access."
    confirmLabel="Revoke" pendingLabel="Revoking access…" onConfirm={() => pending} onClose={close} />));
  const buttons = [...document.querySelectorAll("button")];
  buttons.find(button => button.textContent === "Revoke")!.focus();
  act(() => buttons.find(button => button.textContent === "Revoke")!.click());
  expect(document.activeElement).toBe(document.querySelector("dialog"));
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(document.querySelector("dialog"));
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(document.querySelector("dialog"));
  expect(document.body.textContent).toContain("Revoking access…");
  act(() => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve!());
  expect(document.body.textContent).not.toContain("Revoking access…");
  expect(document.activeElement?.textContent).toBe("Cancel");
});

it("keeps the first mark build under StrictMode but does not replay on navigation", () => {
  vi.useFakeTimers();
  act(() => root.render(<StrictMode><MdbaseMark key="first" motion="keys-first" /></StrictMode>));
  expect(host.querySelector(".mdbase-motion-keys-first")).not.toBeNull();
  act(() => vi.advanceTimersByTime(1300));
  expect(host.querySelector(".mdbase-motion-keys-first")).toBeNull();
  act(() => root.render(<StrictMode><MdbaseMark key="next" motion="keys-first" /></StrictMode>));
  expect(host.querySelector(".mdbase-motion-keys-first")).toBeNull();
});
