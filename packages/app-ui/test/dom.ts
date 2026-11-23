/**
 * What the component tests do to a page: render into it, find a control by its role and
 * accessible name, and press, type and key as a person would.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { accessibleName } from "./label-in-name.js";

// jsdom has no Popover API and no animations.
HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) { delete this.dataset.popoverOpen; };
HTMLElement.prototype.getAnimations = () => [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();

export function mount(node: ReactNode): { host: HTMLElement; render: (next: ReactNode) => void; unmount: () => void } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(node));
  return {
    host,
    render: (next) => act(() => root.render(next)),
    unmount: () => {
      roots.delete(root);
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Takes down everything `mount` put up. */
export function cleanup(): void {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.innerHTML = "";
}

const implicit: Record<string, string> = {
  button: 'button:not([role]), [role="button"]',
  checkbox: 'input[type="checkbox"]:not([role]), [role="checkbox"]',
  radio: 'input[type="radio"]:not([role]), [role="radio"]',
  textbox: 'input:not([type]):not([role]), input[type="text"]:not([role]), textarea:not([role]), [role="textbox"]',
};

/** A control's accessible name: its `aria-label`, the label around it, or the text it shows. */
export function nameOf(element: Element): string {
  if (!element.hasAttribute("aria-label") && element.matches("input, textarea")) {
    const label = element.closest("label");
    if (label) return accessibleName(label);
  }
  return accessibleName(element);
}

type Scope = ParentNode | null | undefined;
const named = (name: string | RegExp | undefined) => (element: Element): boolean =>
  name === undefined || (typeof name === "string" ? nameOf(element) === name : name.test(nameOf(element)));

/** Every element of a role, optionally with a name, in the page or under `scope`. */
export function all(role: string, name?: string | RegExp, scope?: Scope): HTMLElement[] {
  return [...(scope ?? document.body).querySelectorAll<HTMLElement>(implicit[role] ?? `[role="${role}"]`)].filter(named(name));
}

/** The one element of a role with a name; an error when there is none or several. */
export function get(role: string, name?: string | RegExp, scope?: Scope): HTMLElement {
  const found = all(role, name, scope);
  if (found.length !== 1) {
    const there = all(role, undefined, scope).map((element) => JSON.stringify(nameOf(element))).join(", ");
    throw new Error(`Expected one ${role} named ${String(name)}, found ${String(found.length)}. There: ${there || "none"}`);
  }
  return found[0]!;
}

export function find(role: string, name?: string | RegExp, scope?: Scope): HTMLElement | null {
  return all(role, name, scope)[0] ?? null;
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';
const Pointer = (typeof PointerEvent === "function" ? PointerEvent : MouseEvent) as typeof MouseEvent;

/** A press with the mouse: the focus moves as a browser moves it, unless the page keeps it. */
export function click(element: Element, init: MouseEventInit = {}): void {
  const options = { bubbles: true, cancelable: true, ...init };
  act(() => {
    element.dispatchEvent(new Pointer("pointerdown", options));
    if (!element.isConnected) return;
    if (element.dispatchEvent(new MouseEvent("mousedown", options))) {
      const target = element.closest<HTMLElement>(FOCUSABLE);
      if (target && !target.matches(":disabled")) target.focus();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  });
  act(() => {
    if (!element.isConnected) return;
    element.dispatchEvent(new Pointer("pointerup", options));
    element.dispatchEvent(new MouseEvent("mouseup", options));
    if (element instanceof HTMLElement && !init.button) element.click();
    else if (init.button === 2) element.dispatchEvent(new MouseEvent("contextmenu", options));
  });
}

/** Replaces a field's text, as selecting it all and typing does. */
export function type(element: Element, text: string): void {
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A key pressed where the keyboard is. Enter and Space press a focused button, as a browser has them do. */
export function key(name: string, init: KeyboardEventInit = {}): void {
  const target = document.activeElement ?? document.body;
  let taken = false;
  act(() => {
    taken = !target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
  if (!taken && (name === "Enter" || name === " ") && target instanceof HTMLButtonElement && target.isConnected) act(() => target.click());
}
