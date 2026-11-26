// @vitest-environment jsdom
import { act, useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, cleanup, click, find, get, key, mount, type } from "../../test/dom.js";
import { formatDay } from "../DatePicker.js";
import type { PropertyInfo } from "./model.js";
import { PropertyList, type PropertyListProps } from "./PropertyList.js";
import type { PropertyLinkCreation, PropertyRecords } from "./PropertyValue.js";

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
    expect(get("button", "Show 4 empty fields").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the empty ones when asked, in the type's order, and remembers that", () => {
    const first = show();
    click(get("button", "Show 4 empty fields"));
    expect(rows()).toEqual(["status", "due", "assignee", "estimate", "contexts", "rating"]);
    expect(get("button", "Hide empty fields").getAttribute("aria-expanded")).toBe("true");
    first.unmount();
    show();
    expect(rows()).toHaveLength(6);
  });

  it("leaves out the names it is told to hide", () => {
    show({ hidden: (name) => name === "rating" || name === "due" });
    expect(rows()).toEqual(["status"]);
    expect(get("button", "Show 3 empty fields")).toBeTruthy();
  });

  it("adds a declared property by finding it, and puts the keyboard in its value", () => {
    const { onChange } = show();
    click(get("button", "Add property"));
    enter("assi");
    expect(rows()).toEqual(["status", "assignee", "rating"]);
    expect(document.activeElement).toBe(get("textbox", "assignee"));
    enter("me");
    expect(onChange).toHaveBeenCalledWith("assignee", "me");
    expect(get("button", "Show 3 empty fields")).toBeTruthy();
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

  it("shows a value with parts of its own part by part, under its name", () => {
    show({ values: { progress: { status: "reading", page: 12, notes: ["a"] } } });
    expect(rows()).toEqual(["progress", "progress.status", "progress.page", "progress.notes"]);
    expect(get("button", "progress: 3 properties").getAttribute("aria-expanded")).toBe("true");
    expect(get("group", "progress")).toBeTruthy();
  });

  it("changes a part in place and gives the whole value, changed", () => {
    const { onChange } = show({ values: { progress: { status: "reading", page: 12 } } });
    type(get("textbox", "progress page"), "40");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("progress", { status: "reading", page: 40 });
    click(get("button", "Remove progress status"));
    expect(onChange).toHaveBeenLastCalledWith("progress", { page: 12 });
  });

  it("adds a part to a value: one its type names, or one of its own name", () => {
    const parts: PropertyInfo[] = [{ name: "status", kind: "text", options: ["reading", "read"] }, { name: "page", kind: "number" }];
    const { onChange } = show({ values: { progress: { page: 12 } }, declared: [{ name: "progress", kind: "group", parts }] });
    expect(rows()).toEqual(["progress", "progress.page"]);
    click(get("button", "Add property to progress"));
    enter("stat");
    expect(rows()).toEqual(["progress", "progress.status", "progress.page"]);
    click(get("option", "read"));
    expect(onChange).toHaveBeenLastCalledWith("progress", { page: 12, status: "read" });
    click(get("button", "Add property to progress"));
    enter("shelf");
    enter("B4");
    expect(onChange).toHaveBeenLastCalledWith("progress", { page: 12, shelf: "B4" });
  });

  it("takes only the parts its type names in a value that may hold no others", () => {
    show({ values: { size: { width: 2 } }, declared: [{ name: "size", kind: "group", rest: false, parts: [{ name: "width", kind: "number" }, { name: "height", kind: "number" }] }] });
    click(get("button", "Add property to size"));
    type(document.activeElement!, "depth");
    expect(find("option")).toBeNull();
    type(document.activeElement!, "hei");
    expect(all("option").map((option) => option.textContent)).toEqual(["height"]);
  });

  it("starts a declared value with parts from nothing", () => {
    const { onChange } = show({ values: {}, declared: [{ name: "progress", kind: "group", parts: [{ name: "page", kind: "number", required: true }] }] });
    click(get("button", "Add property"));
    enter("progress");
    // The part it must have is there to be filled in.
    expect(rows()).toEqual(["progress", "progress.page"]);
    type(get("textbox", "progress page"), "3");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("progress", { page: 3 });
  });

  it("folds a value away, and starts a large one folded", () => {
    const big = Object.fromEntries(Array.from({ length: 9 }, (_item, index) => [`part${String(index)}`, index]));
    show({ values: { progress: { page: 12 }, big } });
    expect(rows()).toEqual(["progress", "progress.page", "big"]);
    click(get("button", "progress: 1 property"));
    expect(rows()).toEqual(["progress", "big"]);
    click(get("button", "big: 9 properties"));
    expect(rows()).toHaveLength(11);
  });

  it("shows a list of values with parts one by one, by their place", () => {
    const { onChange } = show({ values: { steps: [{ title: "Read", done: true }, { title: "Review" }] } });
    expect(rows()).toEqual(["steps", "steps.0", "steps.0.title", "steps.0.done", "steps.1", "steps.1.title"]);
    expect(get("button", "steps: 2 items")).toBeTruthy();
    type(get("textbox", "steps 2 title"), "Revise");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("steps", [{ title: "Read", done: true }, { title: "Revise" }]);
    click(get("button", "Remove item 1 from steps"));
    expect(onChange).toHaveBeenLastCalledWith("steps", [{ title: "Review" }]);
  });

  it("adds a value to a list with the parts it must have", () => {
    const step: PropertyInfo = { name: "", kind: "group", parts: [{ name: "title", kind: "text", required: true }, { name: "done", kind: "boolean" }] };
    const { onChange } = show({ values: { steps: [] }, declared: [{ name: "steps", kind: "list", items: step, required: true }] });
    expect(rows()).toEqual(["steps"]);
    expect(get("button", "steps: Empty").getAttribute("aria-expanded")).toBe("true");
    click(get("button", "Add item to steps"));
    expect(onChange).toHaveBeenLastCalledWith("steps", [{ title: "" }]);
  });

  it("adds a value like the others to a list no type describes", () => {
    const { onChange } = show({ values: { steps: [{ title: "Read" }], flags: [true] }, declared: [] });
    click(get("button", "Add item to steps"));
    expect(onChange).toHaveBeenLastCalledWith("steps", [{ title: "Read" }, {}]);
    click(get("button", "Add item to flags"));
    expect(onChange).toHaveBeenLastCalledWith("flags", [true, null]);
  });

  it("names a value in a list by the first thing it says, and offers a new one the parts the others have", () => {
    function Held(): JSX.Element {
      const [held, setHeld] = useState<Record<string, unknown>>({ steps: [{ done: true, title: "Read" }] });
      return <PropertyList values={held} declared={[]} onChange={(name, value) => setHeld((was) => ({ ...was, [name]: value }))} />;
    }
    mount(<Held />);
    expect(get("button", "steps 1: Read")).toBeTruthy();
    click(get("button", "Add item to steps"));
    // The new value has nothing yet: its first part is asked for at once.
    expect(rows()).toEqual(["steps", "steps.0", "steps.0.done", "steps.0.title", "steps.1"]);
    expect(document.activeElement!.getAttribute("role")).toBe("combobox");
    expect(all("option").map((option) => option.textContent)).toEqual(["done", "title"]);
    enter("title");
    enter("Review");
    expect(get("button", "steps 2: Review")).toBeTruthy();
    expect(rows().slice(4)).toEqual(["steps.1", "steps.1.title"]);
  });

  it("edits a declared moment with the browser's date and time control, and stores it in UTC", () => {
    const { onChange } = show({ values: { starts: "2026-07-21T05:15:30.000Z" }, declared: [{ name: "starts", kind: "text", format: "date-time" }] });
    const field = document.querySelector<HTMLInputElement>('[data-field="starts"] input')!;
    expect(field.type).toBe("datetime-local");
    expect(field.getAttribute("aria-label")).toBe("starts");
    type(field, "2026-07-23T09:45:00");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("starts", new Date("2026-07-23T09:45:00").toISOString());
  });

  it("puts right a value that is not what its type says, by what is typed", () => {
    const { onChange } = show({
      values: { rating: 49, count: "7", tags: "original" },
      declared: [{ name: "rating", kind: "text" }, { name: "count", kind: "number" }, { name: "tags", kind: "list", items: { name: "", kind: "text" } }],
    });
    // Each is shown as its type has it, holding what the record holds.
    const rating = get("textbox", "rating") as HTMLInputElement;
    expect(rating.value).toBe("49");
    expect(rating.inputMode).toBe("");
    // Enter says the text is right as it reads.
    rating.focus();
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("rating", "49");
    get("textbox", "count").focus();
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("count", 7);
    expect(get("button", "Remove original")).toBeTruthy();
    type(get("textbox", "tags"), "next");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("tags", ["original", "next"]);
  });

  it("leaves a value alone when its field is only passed through", () => {
    const { onChange } = show({ values: { rating: 49 }, declared: [{ name: "rating", kind: "text" }] });
    const rating = get("textbox", "rating");
    rating.focus();
    act(() => rating.blur());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names a value in a list by what it says in its own words, not by a choice its type lists", () => {
    const contact: PropertyInfo = { name: "", kind: "group", parts: [{ name: "kind", kind: "text", options: ["email", "phone"] }, { name: "value", kind: "text" }] };
    show({ values: { contacts: [{ kind: "email", value: "ada@example.com" }] }, declared: [{ name: "contacts", kind: "list", items: contact }] });
    expect(get("button", "contacts 1: ada@example.com")).toBeTruthy();
  });

  it("leaves no way to add to a value that holds every part it may", () => {
    show({ values: { size: { width: 2 } }, declared: [{ name: "size", kind: "group", rest: false, parts: [{ name: "width", kind: "number" }] }] });
    expect(find("button", "Add property to size")).toBeNull();
  });

  it("shows nested values without controls when the record cannot be changed", () => {
    show({ onChange: undefined, values: { progress: { page: 12 }, steps: [{ title: "Read" }], due: "2026-11-28" } });
    expect(rows()).toEqual(["due", "progress", "progress.page", "steps", "steps.0", "steps.0.title"]);
    expect(document.querySelector('[data-field="due"] .mdbase-property-static')!.textContent).toBe(formatDay("2026-11-28"));
    expect(find("textbox")).toBeNull();
    expect(find("button", /Add/)).toBeNull();
    expect(find("button", /Remove/)).toBeNull();
  });

  it("always shows a property the record must have, marks it, and does not take it off", () => {
    show({ values: { done: false }, declared: [{ name: "title", kind: "text", required: true }, { name: "done", kind: "boolean", required: true }, { name: "notes", kind: "text" }] });
    expect(rows()).toEqual(["title", "done"]);
    expect(document.querySelector('[data-field="title"] .mdbase-property-required')!.getAttribute("title")).toBe("Required");
    expect(document.querySelector('[data-field="notes"] .mdbase-property-required')).toBeNull();
    expect(find("button", /^Remove/)).toBeNull();
  });

  it("takes a declared switch or value with parts off by its row, since no control empties one", () => {
    const { onChange } = show({ values: { done: false, progress: { page: 1 } }, declared: [{ name: "done", kind: "boolean" }, { name: "progress", kind: "group" }] });
    click(get("button", "Remove done"));
    expect(onChange).toHaveBeenLastCalledWith("done", null);
    click(get("button", "Remove progress"));
    expect(onChange).toHaveBeenLastCalledWith("progress", null);
  });

  it("says what is wrong with a value under it, wherever the value is", () => {
    show({ values: { estimate: "soon", steps: [{ title: "" }] }, errors: { estimate: "Enter a number.", "steps.0.title": "Enter at least 1 character." } });
    const estimate = document.querySelector('[data-field="estimate"]')!;
    expect(estimate.hasAttribute("data-invalid")).toBe(true);
    expect(estimate.querySelector('[role="alert"]')!.textContent).toBe("Enter a number.");
    expect(document.querySelector('[data-field="steps.0.title"] [role="alert"]')!.textContent).toBe("Enter at least 1 character.");
    expect(document.querySelector('[data-field="steps"]')!.hasAttribute("data-invalid")).toBe(false);
  });

  it("keeps a list of numbers a list of numbers", () => {
    const { onChange } = show({ values: { sizes: [1, 2] }, declared: [] });
    type(get("textbox", "sizes"), "3, large");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("sizes", [1, 2, 3, "large"]);
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

  it("links one record through a property its type says links one, as the host writes and reads links", () => {
    const people = [{ path: "people/ada.md", title: "Ada Lovelace" }, { path: "people/alan.md", title: "Alan Turing" }];
    const search = vi.fn((query: string) => people.filter((person) => person.title.toLowerCase().includes(query.toLowerCase())));
    const records: PropertyRecords = {
      describe: (path) => people.find((person) => person.path === path),
      search,
      resolve: (link) => (link.includes("ada") ? "people/ada.md" : link.includes("pending") ? undefined : null),
      link: (path, title) => `[${title}](</${path}>)`,
    };
    const author: PropertyInfo = { name: "author", kind: "text", link: { many: false } };
    const view = show({ values: {}, declared: [author, { name: "editors", kind: "list", link: { many: true } }], records });
    click(get("button", "Show 2 empty fields"));
    click(get("button", "Link a record in author"));
    type(get("combobox", "Link a record in author"), "al");
    expect(search).toHaveBeenLastCalledWith("al", "author");
    key("Enter");
    expect(view.onChange).toHaveBeenLastCalledWith("author", "[Alan Turing](</people/alan.md>)");
    view.render(<PropertyList values={{ author: "[Ada](</people/ada.md>)", editors: ["[x](</nowhere.md>)", "[y](</pending.md>)"] }} declared={[author, { name: "editors", kind: "list", link: { many: true } }]} records={records} onChange={view.onChange} />);
    // One record is linked: there is no second to add, and the link is named for the record it leads to.
    expect(find("button", "Link a record in author")).toBeNull();
    expect(document.querySelector('[data-field="author"] .mdbase-token-open')!.textContent).toBe("Ada Lovelace");
    const editors = [...document.querySelectorAll('[data-field="editors"] .mdbase-token')];
    // A link that leads nowhere is marked; one still being looked up is not.
    expect(editors.map((chip) => chip.hasAttribute("data-missing"))).toEqual([true, false]);
    click(get("button", "Remove Ada Lovelace"));
    expect(view.onChange).toHaveBeenLastCalledWith("author", null);
    click(get("button", "Remove x"));
    expect(view.onChange).toHaveBeenLastCalledWith("editors", ["[y](</pending.md>)"]);
  });

  it("makes a record from what was typed where the host can, and links it when it exists", () => {
    const create = vi.fn();
    const records: PropertyRecords = {
      describe: () => undefined,
      search: () => [],
      creates: (property) => (property === "author" ? [{ id: "person", label: "New person" }] : []),
      create,
    };
    const { onChange } = show({ values: { author: [] }, declared: [{ name: "author", kind: "list", link: { many: true }, required: true }], records });
    click(get("button", "Link a record in author"));
    type(get("combobox", "Link a record in author"), "Grace Hopper");
    expect(all("option").map((option) => option.textContent)).toEqual(["New person “Grace Hopper”"]);
    key("Enter");
    expect(create).toHaveBeenCalledWith("person", "Grace Hopper", expect.objectContaining({ property: "author" }));
    const creation = create.mock.calls[0]![2] as PropertyLinkCreation;
    act(() => creation.link("people/grace.md", "Grace Hopper"));
    expect(onChange).toHaveBeenLastCalledWith("author", ["[[people/grace]]"]);
  });

  it("names a link without a way to open it when the host gives none", () => {
    show({ values: { author: "[[people/ada|Ada]]" }, declared: [] });
    expect(find("button", "Ada")).toBeNull();
    expect(document.querySelector(".mdbase-token-open")!.textContent).toBe("Ada");
  });

  it("surfaces empty declared nested parts from the same empty-fields disclosure", () => {
    const { onChange } = show({
      values: { profile: { display_name: "Ada" } },
      declared: [{
        name: "profile",
        kind: "group",
        parts: [
          { name: "display_name", kind: "text", required: true },
          { name: "bio", kind: "text" },
          { name: "website", kind: "text" },
        ],
      }],
    });
    expect(rows()).toEqual(["profile", "profile.display_name"]);
    click(get("button", "Show 2 empty fields"));
    expect(rows()).toEqual(["profile", "profile.display_name", "profile.bio", "profile.website"]);
    type(get("textbox", "profile bio"), "Mathematician");
    key("Enter");
    expect(onChange).toHaveBeenLastCalledWith("profile", { display_name: "Ada", bio: "Mathematician" });
    click(get("button", "Hide empty fields"));
    expect(rows()).toEqual(["profile", "profile.display_name"]);
  });

  it("shows the text a host passes in place of the shared catalogue's", () => {
    show({ labels: { addProperty: "Ajouter une propriété", showEmpty: (count) => `${String(count)} vides` } });
    expect(get("button", "Ajouter une propriété")).toBeTruthy();
    expect(get("button", "4 vides")).toBeTruthy();
  });
});
