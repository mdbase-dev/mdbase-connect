// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "./Select.js";
import "../test/dialog.js";

// jsdom has no Popover API.
HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) { delete this.dataset.popoverOpen; };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Labelled() {
  const [value, setValue] = useState("a");
  return <label>
    <span>Collection</span>
    <Select aria-label="Collection" value={value} options={[{ value: "a", label: "Notes" }, { value: "b", label: "Drafts" }]} onChange={setValue} />
  </label>;
}

afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Select", () => {
  it("opens from its label's text, like a native select", () => {
    const host = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(host).render(<Labelled />));
    act(() => host.querySelector("span")!.click());
    expect(host.querySelector('[role="combobox"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  it("refocuses the retained list when reopening during its exit", () => {
    vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([{ finished: new Promise<void>(() => {}) }] as Animation[]);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<Labelled />));
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    act(() => trigger.click());
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    expect(host.querySelector('[role="listbox"]')).toBe(list);
    expect(document.activeElement).toBe(list);
    act(() => root.unmount());
  });
});
