// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Select } from "./Select.js";

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

afterEach(() => { document.body.innerHTML = ""; });

describe("Select", () => {
  it("opens from its label's text, like a native select", () => {
    const host = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(host).render(<Labelled />));
    act(() => host.querySelector("span")!.click());
    expect(host.querySelector('[role="combobox"]')!.getAttribute("aria-expanded")).toBe("true");
  });
});
