// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkPicker, linkPickerRows, type LinkPickerCreate, type LinkPickerOption } from "./LinkPicker.js";

// jsdom has no Popover API and no animations.
HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) { this.dataset.popoverOpen = ""; };
HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) { delete this.dataset.popoverOpen; };
HTMLElement.prototype.getAnimations = () => [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const people: LinkPickerOption[] = [
  { id: "People/Ada Lovelace.md", title: "Ada Lovelace", detail: "Person" },
  { id: "People/Alan Turing.md", title: "Alan Turing", detail: "Person" },
];
const person: LinkPickerCreate = { id: "person", label: "New person" };

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("linkPickerRows", () => {
  it("offers nothing to create until something is typed", () => {
    expect(linkPickerRows("  ", people, [person])).toEqual(people.map((option) => ({ kind: "option", option })));
  });

  it("lists the kinds that can be made after the matches, with the typed title tidied", () => {
    expect(linkPickerRows("  Grace   Hopper ", people.slice(0, 1), [person]).at(-1))
      .toEqual({ kind: "create", create: person, title: "Grace Hopper" });
  });

  it("does not offer a second record under a title that already matches", () => {
    expect(linkPickerRows("ada lovelace", people, [person]).some((row) => row.kind === "create")).toBe(false);
  });
});

function Picker({ onPick, onCreate, onClose }: {
  onPick: (option: LinkPickerOption) => void;
  onCreate: (create: LinkPickerCreate, title: string) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  return <LinkPicker
    label="Author"
    query={query}
    onQueryChange={setQuery}
    options={people.filter((option) => option.title.toLowerCase().includes(needle))}
    creates={[person]}
    emptyMessage="No people yet."
    onPick={onPick}
    onCreate={onCreate}
    onClose={onClose}
  />;
}

function mount(props: Parameters<typeof Picker>[0]) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<Picker {...props} />));
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const type = (text: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (name: string) => act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  const rows = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.textContent);
  return { host, input, type, key, rows, unmount: () => act(() => root.unmount()) };
}

describe("LinkPicker", () => {
  it("keeps the focus in the field and names the row Enter will take", () => {
    const onPick = vi.fn();
    const view = mount({ onPick, onCreate: vi.fn() });
    act(() => view.input.focus());
    expect(view.input.getAttribute("aria-expanded")).toBe("true");
    expect(view.rows()).toEqual(["Ada LovelacePerson", "Alan TuringPerson"]);
    view.key("ArrowDown");
    expect(document.activeElement).toBe(view.input);
    const active = document.getElementById(view.input.getAttribute("aria-activedescendant")!)!;
    expect(active.textContent).toBe("Alan TuringPerson");
    view.key("Enter");
    expect(onPick).toHaveBeenCalledWith(people[1]);
    expect(view.input.getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });

  it("makes a record of the offered kind from what was typed", () => {
    const onCreate = vi.fn();
    const view = mount({ onPick: vi.fn(), onCreate });
    act(() => view.input.focus());
    view.type("Grace Hopper");
    expect(view.rows()).toEqual(["New person “Grace Hopper”"]);
    view.key("Enter");
    expect(onCreate).toHaveBeenCalledWith(person, "Grace Hopper");
    view.unmount();
  });

  it("returns to the best match when the text changes", () => {
    const onPick = vi.fn();
    const view = mount({ onPick, onCreate: vi.fn() });
    act(() => view.input.focus());
    view.key("ArrowDown");
    view.type("a");
    view.key("Enter");
    expect(onPick).toHaveBeenCalledWith(people[0]);
    view.unmount();
  });

  it("closes the list on the first Escape and the picker on the second", () => {
    const onClose = vi.fn();
    const view = mount({ onPick: vi.fn(), onCreate: vi.fn(), onClose });
    act(() => view.input.focus());
    view.key("Escape");
    expect(view.input.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    view.key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("picks a row with the pointer without taking the focus from the field", () => {
    const onPick = vi.fn();
    const view = mount({ onPick, onCreate: vi.fn() });
    act(() => view.input.focus());
    const row = view.host.querySelector<HTMLElement>('[role="option"]')!;
    const press = new Event("pointerdown", { bubbles: true, cancelable: true });
    act(() => { row.dispatchEvent(press); });
    expect(press.defaultPrevented).toBe(true);
    act(() => row.click());
    expect(onPick).toHaveBeenCalledWith(people[0]);
    view.unmount();
  });
});
