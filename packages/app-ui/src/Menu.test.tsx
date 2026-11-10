// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { Menu } from "./Menu.js";

// jsdom has no Popover API.
HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) { delete this.dataset.popoverOpen; };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Open() {
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger}>Options</button>
    <Menu open id="menu" triggerRef={trigger} onClose={() => undefined}>
      <input aria-label="Filter" />
      <button role="menuitem">First</button>
      <button role="menuitemradio"><span>Second</span></button>
      <button role="menuitem" disabled>Third</button>
    </Menu>
  </>;
}

function mount() {
  const host = document.body.appendChild(document.createElement("div"));
  act(() => createRoot(host).render(<Open />));
  const [input, first, second, third] = [host.querySelector("input")!, ...host.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  return { input, first: first!, second: second!, third: third! };
}

const hover = (target: Element, pointerType = "mouse") =>
  act(() => { target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType })); });

afterEach(() => { document.body.innerHTML = ""; });

it("moves keyboard focus to the row under the mouse, so one row is marked", () => {
  const { first, second, third } = mount();
  first.focus();
  hover(second.querySelector("span")!);
  expect(document.activeElement).toBe(second);
  hover(third);
  expect(document.activeElement).toBe(second);
});

it("leaves focus in a menu field and ignores touch", () => {
  const { input, first, second } = mount();
  input.focus();
  hover(second);
  expect(document.activeElement).toBe(input);
  first.focus();
  hover(second, "touch");
  expect(document.activeElement).toBe(first);
});
