// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Toaster, toast } from "./Toaster.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
function mount() {
  vi.useFakeTimers();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(<Toaster />));
}
afterEach(async () => { act(() => root.unmount()); await Promise.resolve(); vi.useRealTimers(); document.body.innerHTML = ""; });

it("announces one toast at a time and runs Undo once", () => {
  mount();
  const undo = vi.fn();
  act(() => { toast("Renamed", undo); toast("Second change"); });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Renamed");
  expect(host.textContent).not.toContain("Second change");
  act(() => host.querySelector("button")!.click());
  expect(undo).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Second change");
  act(() => vi.advanceTimersByTime(5_000));
  expect(host.textContent).toBe("");
});

it("pauses expiry while hovered or keyboard-focused", () => {
  mount();
  act(() => toast("Saved", vi.fn()));
  act(() => vi.advanceTimersByTime(3_000));
  act(() => host.querySelector('[role="status"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  act(() => vi.advanceTimersByTime(20_000));
  expect(host.textContent).toContain("Saved");
  act(() => host.querySelector("button")!.focus());
  act(() => host.querySelector('[role="status"]')!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  act(() => vi.advanceTimersByTime(20_000));
  expect(host.textContent).toContain("Saved");
  act(() => host.querySelector("button")!.blur());
  act(() => vi.advanceTimersByTime(5_000));
  expect(host.textContent).toBe("");
});

it("resumes the queue after a focused Undo button disappears", () => {
  mount();
  act(() => { toast("Renamed", vi.fn()); toast("Next change"); });
  act(() => host.querySelector("button")!.focus());
  act(() => host.querySelector("button")!.click());
  act(() => vi.advanceTimersByTime(5_000));
  expect(host.textContent).toBe("");
});

it("preserves a mount-time announcement through StrictMode effect replay", () => {
  mount();
  let announced = false;
  function Announcement() {
    useEffect(() => { if (!announced) { announced = true; toast("Connected"); } }, []);
    return null;
  }
  act(() => root.render(<StrictMode><Announcement /><Toaster /></StrictMode>));
  expect(host.textContent).toContain("Connected");
});

it("bounds the queue and clears it when its owner unmounts", () => {
  mount();
  act(() => { for (const message of ["one", "two", "three", "four", "five"]) toast(message); });
  expect(host.textContent).toContain("one");
  act(() => vi.advanceTimersByTime(5_000));
  expect(host.textContent).toContain("three");
});
