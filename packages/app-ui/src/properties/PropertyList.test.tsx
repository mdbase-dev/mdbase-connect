// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, cleanup, click, find, get, key, mount, type } from "../../test/dom.js";
import type { PropertyInfo } from "./model.js";
import { PropertyList, type PropertyListProps } from "./PropertyList.js";
import type { PropertyRecords } from "./PropertyValue.js";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const declared: PropertyInfo[] = [
  { name: "status", kind: "text", options: ["open", "done"] },
  { name: "due", kind: "text", format: "date" },
  { name: "assignee", kind: "text" },
  { name: "estimate", kind: "number" },
  { name: "contexts", kind: "list" },
];
const values = { status: "open", assignee: "", contexts: [], rating: 4 };
const rows = (): (string | null)[] => [...document.querySelectorAll(".mdbase-property")].map((row) => row.getAttribute("data-field"));

function show(props: Partial<PropertyListProps> = {}) {
  const onChange = vi.fn();
  const view = mount(<PropertyList values={values} declared={declared} onChange={onChange} {...props} />);
  return { onChange, ...view };
}

/** Types into the field that has the keyboard, then presses Enter. */
function enter(text: string): void {
  type(document.activeElement!, text);
  key("Enter");
}

describe("PropertyList", () => {
  it("shows the properties that hold something and counts the rest", () => {
    show();
    expect(rows()).toEqual(["status", "rating"]);
    expect(get("button", "4 empty").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the empty ones when asked, in the type's order, and remembers that", () => {
    const first = show();
    click(get("button", "4 empty"));
    expect(rows()).toEqual(["status", "due", "assignee", "estimate", "contexts", "rating"]);
    expect(get("button", "Hide empty").getAttribute("aria-expanded")).toBe("true");
    first.unmount();
    show();
    expect(rows()).toHaveLength(6);
  });

  it("leaves out the names it is told to hide", () => {
    show({ hidden: (name) => name === "rating" || name === "due" });
    expect(rows()).toEqual(["status"]);
    expect(get("button", "3 empty")).toBeTruthy();
  });

  it("adds a declared property by finding it, and puts the keyboard in its value", () => {
    const { onChange } = show();
    click(get("button", "Add property"));
    enter("assi");
    expect(rows()).toEqual(["status", "assignee", "rating"]);
    expect(document.activeElement).toBe(get("textbox", "assignee"));
    enter("me");
    expect(onChange).toHaveBeenCalledWith("assignee", "me");
    expect(get("button", "3 empty")).toBeTruthy();
  });

  it("adds a property of its own name, reading a number as a number", () => {
    const { onChange } = show();
    click(get("button", "Add property"));
    enter("pages");
    expect(rows()).toEqual(["status", "rating", "pages"]);
    enter("320");
    expect(onChange).toHaveBeenCalledWith("pages", 320);
  });

  it("drops a new property that was given no value", () => {
    const { onChange } = show();
    click(get("button", "Add property"));
    enter("pages");
    key("Escape");
    expect(rows()).toEqual(["status", "rating"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses a name a property cannot have", () => {
    show();
    click(get("button", "Add property"));
    type(document.activeElement!, "2 much");
    expect(find("option")).toBeNull();
    expect(document.body.textContent).toContain("Use letters, digits, - and _, starting with a letter.");
  });

  it("offers the values other records hold for a property no type describes", () => {
    const { onChange } = show({ inUse: [{ name: "stage", kind: "text", options: ["draft", "final"] }] });
    click(get("button", "Add property"));
    enter("stage");
    expect(document.activeElement).toBe(get("combobox", "stage"));
    expect(all("option").map((option) => option.textContent)).toEqual(["draft", "final"]);
    enter("fin");
    expect(onChange).toHaveBeenCalledWith("stage", "final");
  });

  it("keeps a property in view after it is emptied", () => {
    const view = show();
    view.render(<PropertyList values={{ ...values, rating: null }} declared={declared} onChange={view.onChange} />);
    expect(rows()).toEqual(["status", "rating"]);
  });

  it("takes a property no type declares off the record, and leaves a declared one its row", () => {
    const { onChange } = show();
    expect(find("button", "Remove status")).toBeNull();
    click(get("button", "Remove rating"));
    expect(onChange).toHaveBeenCalledWith("rating", null);
  });

  it("changes a choice, a number and a list in place", () => {
    const { onChange } = show({ values: { status: "open", estimate: 2, contexts: ["home"] } });
    click(get("combobox", "status"));
    click(get("option", "done"));
    expect(onChange).toHaveBeenLastCalledWith("status", "done");
    type(get("textbox", "estimate"), "3.5");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("estimate", 3.5);
    type(get("textbox", "contexts"), "work, errands");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("contexts", ["home", "work", "errands"]);
    click(get("button", "Remove home"));
    expect(onChange).toHaveBeenLastCalledWith("contexts", []);
  });

  it("gives back what was there when an edit is given up", () => {
    const { onChange } = show({ values: { assignee: "ada" } });
    const field = get("textbox", "assignee") as HTMLInputElement;
    type(field, "alan");
    key("Escape");
    expect(field.value).toBe("ada");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("only shows the properties when the record cannot be changed", () => {
    show({ onChange: undefined, values: { status: "open", done: true, rating: 4 } });
    expect(rows()).toEqual(["status", "done", "rating"]);
    expect(find("button", "Add property")).toBeNull();
    expect(find("combobox")).toBeNull();
    expect([...document.querySelectorAll(".mdbase-property-static")].map((value) => value.textContent)).toEqual(["open", "yes", "4"]);
  });

  it("shows a value with parts of its own part by part", () => {
    show({ values: { progress: { status: "reading", page: 12, notes: ["a"] } } });
    expect(rows()).toEqual(["progress.status", "progress.page", "progress.notes"]);
  });

  it("names a linked record, opens it, and links another that is searched for", () => {
    const people = [{ path: "people/ada.md", title: "Ada Lovelace", detail: "person" }, { path: "people/alan.md", title: "Alan Turing" }];
    const open = vi.fn();
    const records: PropertyRecords = {
      describe: (path) => people.find((person) => person.path === path),
      search: (query) => people.filter((person) => person.title.toLowerCase().includes(query.toLowerCase())),
      open,
    };
    const { onChange } = show({ values: { author: "[[people/ada]]", editor: ["[[people/gone|Someone]]"] }, declared: [], records });
    click(get("button", "Ada Lovelace"));
    expect(open).toHaveBeenCalledWith("people/ada.md");
    expect(get("button", "Someone").closest(".mdbase-token")!.hasAttribute("data-missing")).toBe(true);
    click(get("button", "Link a record in author"));
    const picker = get("combobox", "Link a record in author");
    type(picker, "al");
    // The record already linked is not offered again.
    expect(all("option").map((option) => option.textContent)).toEqual(["Alan Turing"]);
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("author", ["[[people/ada]]", "[[people/alan]]"]);
    click(get("button", "Remove Ada Lovelace"));
    expect(onChange).toHaveBeenLastCalledWith("author", null);
  });

  it("names a link without a way to open it when the host gives none", () => {
    show({ values: { author: "[[people/ada|Ada]]" }, declared: [] });
    expect(find("button", "Ada")).toBeNull();
    expect(document.querySelector(".mdbase-token-open")!.textContent).toBe("Ada");
  });

  it("shows the text a host passes in place of the shared catalogue's", () => {
    show({ labels: { addProperty: "Ajouter une propriété", showEmpty: (count) => `${String(count)} vides` } });
    expect(get("button", "Ajouter une propriété")).toBeTruthy();
    expect(get("button", "4 vides")).toBeTruthy();
  });
});
