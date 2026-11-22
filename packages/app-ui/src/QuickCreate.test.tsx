// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuickCreate } from "./QuickCreate.js";

// jsdom has no Popover API, no layout observers and no animations.
HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.getAnimations = () => [];
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { document.body.innerHTML = ""; });

function Form({ onSubmit, onClose, fields = true }: {
  onSubmit: (name: string, isbn: string) => void;
  onClose: (refocus: boolean) => void;
  fields?: boolean;
}) {
  const [name, setName] = useState("Dune");
  const [isbn, setIsbn] = useState("");
  return <QuickCreate
    title="New book"
    name={name}
    nameLabel="Title"
    onNameChange={setName}
    anchor={() => new DOMRect(40, 40, 200, 24)}
    submitLabel="Create and link"
    blocker={fields && !isbn ? "Give the ISBN." : undefined}
    onSubmit={() => onSubmit(name, isbn)}
    onClose={onClose}
  >
    {fields ? <input aria-label="ISBN" value={isbn} onChange={(event) => setIsbn(event.target.value)} /> : null}
  </QuickCreate>;
}

function mount(props: Partial<Parameters<typeof Form>[0]> = {}) {
  const onSubmit = vi.fn<(name: string, isbn: string) => void>();
  const onClose = vi.fn<(refocus: boolean) => void>();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<Form onSubmit={onSubmit} onClose={onClose} {...props} />));
  const form = host.querySelector<HTMLElement>('[role="dialog"]')!;
  const field = (label: string) => form.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (label: string) => [...form.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  const type = (input: HTMLInputElement, text: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (name: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
    return event;
  };
  return { form, field, button, type, key, onSubmit, onClose, unmount: () => act(() => root.unmount()) };
}

describe("QuickCreate", () => {
  it("opens beside its anchor with the keyboard in the first field after the name", () => {
    const view = mount();
    expect(view.form.getAttribute("aria-label")).toBe("New book");
    expect(view.form.dataset.popoverOpen).toBe("");
    expect(view.form.style.top).not.toBe("");
    expect(view.field("Title").value).toBe("Dune");
    expect(document.activeElement).toBe(view.field("ISBN"));
    view.unmount();
  });

  it("starts in the name when there is nothing else to fill in", () => {
    const view = mount({ fields: false });
    expect(document.activeElement).toBe(view.field("Title"));
    expect(view.button("Create and link").disabled).toBe(false);
    view.unmount();
  });

  it("is submitted only once nothing blocks it", () => {
    const view = mount();
    const submit = view.button("Create and link");
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe("Give the ISBN.");
    // Enter in a field submits the form whatever the button says.
    act(() => { view.form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(view.onSubmit).not.toHaveBeenCalled();

    view.type(view.field("ISBN"), "978-0441172719");
    view.type(view.field("Title"), "Dune Messiah");
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith("Dune Messiah", "978-0441172719");
    view.unmount();
  });

  it("closes on Escape and Cancel handing the keyboard back, and on a press elsewhere without it", () => {
    const view = mount();
    expect(view.key("Escape").defaultPrevented).toBe(true);
    expect(view.onClose).toHaveBeenLastCalledWith(true);
    act(() => view.button("Cancel").click());
    expect(view.onClose).toHaveBeenCalledTimes(2);

    act(() => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(view.onClose).toHaveBeenLastCalledWith(false);
    act(() => { view.field("Title").dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(view.onClose).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it("leaves Escape to a list open inside the form", () => {
    const view = mount();
    view.field("ISBN").setAttribute("aria-expanded", "true");
    expect(view.key("Escape").defaultPrevented).toBe(false);
    expect(view.onClose).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps Tab inside the form", () => {
    const view = mount();
    // Submit is disabled until the ISBN is given, so Cancel is the last stop.
    view.button("Cancel").focus();
    expect(view.key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.field("Title"));
    expect(view.key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.button("Cancel"));
    // Between the ends the browser moves the focus itself.
    view.field("ISBN").focus();
    expect(view.key("Tab").defaultPrevented).toBe(false);
    view.unmount();
  });
});
