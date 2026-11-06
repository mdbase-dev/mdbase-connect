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
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); });

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

it("closes a palette before running its action and does not steal the action's focus", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.useFakeTimers();
  document.documentElement.style.setProperty("--motion-exit", "120ms");
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
  act(() => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  act(() => vi.advanceTimersByTime(120));
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("[data-target]"));
});

it("focuses Cancel, keeps the dialog through exit, reverses, and returns focus", () => {
  vi.useFakeTimers();
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
  dialog.style.setProperty("transition-duration", "0.12s");
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(dialog.parentElement).toBe(document.body);
  act(() => changeOpen!(false));
  expect(document.querySelector("dialog")).toBe(dialog);
  act(() => vi.advanceTimersByTime(60));
  act(() => changeOpen!(true));
  act(() => vi.advanceTimersByTime(120));
  expect(document.querySelector("dialog")).toBe(dialog);
  act(() => changeOpen!(false));
  act(() => vi.advanceTimersByTime(119));
  expect(document.querySelector("dialog")).toBe(dialog);
  act(() => vi.advanceTimersByTime(1));
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
