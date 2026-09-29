// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { AppSwitcher } from "./AppSwitcher.js";

// jsdom has no Popover API.
HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) { delete this.dataset.popoverOpen; };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the app menu", () => {
  it("leads with Editor under the platform mark and groups the workflow apps", () => {
    const host = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(host).render(<AppSwitcher current="reader" />));
    act(() => host.querySelector<HTMLButtonElement>(".mdbase-app-switcher")!.click());

    const lists = [...document.querySelectorAll(".mdbase-menu .mdbase-menu-list")];
    expect(lists.map((list) => [...list.querySelectorAll("strong")].map((name) => name.textContent)))
      .toEqual([["Editor"], ["Reader", "Writer"]]);
    expect(document.querySelector(".mdbase-app-menu-group")?.textContent).toBe("Workflow apps");

    const marks = [...document.querySelectorAll(".mdbase-app-menu-mark")];
    expect(marks.map((mark) => mark.classList.contains("mdbase-mark") ? "platform" : [...mark.classList].find((name) => name.startsWith("is-"))))
      .toEqual(["platform", "is-reader", "is-writer"]);
  });
});
