// @vitest-environment jsdom
import "../test/dialog.js";
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { MdbaseMark } from "./brand.js";
import { CommandPalette } from "./CommandPalette.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); document.documentElement.style.removeProperty("--motion-exit"); });

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
          expect(host.querySelector("dialog")?.open).toBe(false);
          host.querySelector<HTMLButtonElement>("[data-target]")!.focus();
        }
      }]} /></>;
  }
  act(() => root.render(<Host />));
  host.querySelector<HTMLButtonElement>("[data-invoker]")!.focus();
  act(() => openPalette!());
  act(() => host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  act(() => vi.advanceTimersByTime(120));
  expect(host.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector("[data-target]"));
});

it("focuses Cancel, keeps the dialog through exit, reverses, and returns focus", () => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty("--motion-exit", "120ms");
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
  const dialog = host.querySelector("dialog")!;
  dialog.style.setProperty("--motion-exit", "120ms");
  expect(document.activeElement?.textContent).toBe("Cancel");
  act(() => changeOpen!(false));
  expect(host.querySelector("dialog")).toBe(dialog);
  act(() => vi.advanceTimersByTime(60));
  act(() => changeOpen!(true));
  act(() => vi.advanceTimersByTime(120));
  expect(host.querySelector("dialog")).toBe(dialog);
  act(() => changeOpen!(false));
  act(() => vi.advanceTimersByTime(120));
  expect(host.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps a pending confirmation modal and labels its work", async () => {
  const close = vi.fn();
  let resolve: () => void;
  const pending = new Promise<void>(complete => { resolve = complete; });
  act(() => root.render(<ConfirmDialog open title="Revoke Reader" consequence="Reader will lose access."
    confirmLabel="Revoke" pendingLabel="Revoking access…" onConfirm={() => pending} onClose={close} />));
  const buttons = [...host.querySelectorAll("button")];
  act(() => buttons.find(button => button.textContent === "Revoke")!.click());
  expect(host.textContent).toContain("Revoking access…");
  act(() => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve!());
  expect(host.textContent).not.toContain("Revoking access…");
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
