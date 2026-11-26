// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { all, cleanup, click, find, get, key, mount, nameOf, type } from "../../test/dom.js";
import { FilterBuilder, type FilterBuilderProps } from "./FilterBuilder.js";
import type { FilterContextVar, FilterFieldSpec } from "./types.js";

afterEach(cleanup);

const fields: FilterFieldSpec[] = [
  { key: "type", kind: "enum", enumValues: ["expense", "income"] },
  { key: "status", kind: "enum", enumValues: ["draft", "open", "churned", "trial"] },
  { key: "category", kind: "enum", enumValues: ["Software", "Travel", "Office"] },
  { key: "title", label: "Title", kind: "string" },
  { key: "amount", label: "Amount", kind: "number" },
  { key: "date", label: "Date", kind: "date" },
  { key: "paid", label: "Paid", kind: "boolean" },
  { key: "net", label: "Net", kind: "formula" },
];
const contextVars: FilterContextVar[] = [{ expr: "this.fiscal_year", label: "fiscal_year", kind: "number", preview: "2026" }];

function setup(initial: string, props: Partial<FilterBuilderProps> = {}, sharedInitial?: string) {
  const changes = vi.fn<(query: string) => void>();
  const sharedChanges = vi.fn<(query: string) => void>();
  function Harness() {
    const [query, setQuery] = useState(initial);
    const [shared, setShared] = useState(sharedInitial ?? "");
    const tier = sharedInitial === undefined ? {} : { sharedQuery: shared, onSharedChange: (next: string) => { sharedChanges(next); setShared(next); } };
    return <FilterBuilder query={query} fields={fields} contextVars={contextVars} {...tier} {...props} onChange={(next) => { changes(next); setQuery(next); }} />;
  }
  const view = mount(<><Harness /><button type="button">Elsewhere</button></>);
  /** Opens the list of fields and returns its panel. */
  const add = () => {
    click(get("button", "Add filter"));
    return get("dialog", "Add filter");
  };
  return { changes, sharedChanges, add, ...view };
}

/** The pill or group whose accessible name is `name`. */
const pill = (name: string | RegExp, scope?: ParentNode) => get("group", name, scope);
const names = (elements: Element[]) => elements.map(nameOf);

describe("FilterBuilder", () => {
  it("lays every filter out as a pill, an expression or a group", () => {
    setup('type == "expense" && date.year() == this.fiscal_year && (category == "Software" || category == "Travel") && (category == "Office" || amount > 1000) && amount * 1.54 > 1000');
    expect(get("button", "Match all").getAttribute("aria-haspopup")).toBe("menu");
    expect(get("button", "expense", pill("type is expense"))).toBeTruthy();
    expect(get("button", "this.fiscal_year", pill("Date year is this.fiscal_year")).title).toBe("this.fiscal_year · 2026");
    expect(names(all("button", undefined, pill("category is any of Software, Travel")))).toEqual(["category", "is any of", "Software, Travel", "Remove filter"]);
    const group = pill("Any group");
    expect(pill("category is Office", group)).toBeTruthy();
    expect(pill("Amount > 1000", group)).toBeTruthy();
    expect(get("button", "Add filter to group", group)).toBeTruthy();
    expect(get("button", "amount * 1.54 > 1000", pill("Expression amount * 1.54 > 1000"))).toBeTruthy();
    expect(find("dialog")).toBeNull();
  });

  it("says how the filters combine only for several filters or a root that is not all", () => {
    const first = setup("amount > 10");
    expect(find("button", /^Match/u)).toBeNull();
    first.unmount();
    setup('!(status == "churned" || amount > 5)');
    expect(get("button", "Exclude")).toBeTruthy();
    expect(pill("status is churned")).toBeTruthy();
  });

  it("builds a filter on several values that reloads as one pill", () => {
    const { changes, add, unmount } = setup("amount > 10");
    const command = add();
    expect(document.activeElement).toBe(get("combobox", "Filter by field", command));
    click(get("option", "category", command));
    const values = get("group", "Values", command);
    click(get("checkbox", "Software", values));
    expect(changes).toHaveBeenLastCalledWith('amount > 10 && category == "Software"');
    expect(get("button", "is", pill("category is Software"))).toBeTruthy();
    click(get("checkbox", "Travel", values));
    expect(changes).toHaveBeenLastCalledWith('amount > 10 && (category == "Software" || category == "Travel")');
    expect(get("button", "Software, Travel", pill("category is any of Software, Travel"))).toBeTruthy();
    click(get("button", "Done", command));
    expect(find("dialog")).toBeNull();
    expect(document.activeElement).toBe(get("button", "Add filter"));
    unmount();

    const reloaded = setup('amount > 10 && (category == "Software" || category == "Travel")');
    expect(all("group", /category/u)).toHaveLength(1);
    click(get("button", "Software, Travel", pill("category is any of Software, Travel")));
    const editor = get("dialog", "Edit value");
    expect((get("checkbox", "Software", editor) as HTMLInputElement).checked).toBe(true);
    expect((get("checkbox", "Office", editor) as HTMLInputElement).checked).toBe(false);
    click(get("checkbox", "Office", editor));
    expect(reloaded.changes).toHaveBeenLastCalledWith('amount > 10 && (category == "Software" || category == "Travel" || category == "Office")');
    expect(get("button", "3 selected", pill("category is any of Software, Travel, Office"))).toBeTruthy();
    click(get("checkbox", "Software", editor));
    click(get("checkbox", "Office", editor));
    expect(reloaded.changes).toHaveBeenLastCalledWith('amount > 10 && category == "Travel"');
    expect(pill("category is Travel")).toBeTruthy();
  });

  it("flips a rule on several values between any of and none of from its operator", () => {
    const { changes } = setup('category == "Software" || category == "Travel"');
    click(get("button", "is any of", pill("category is any of Software, Travel")));
    const operators = get("menu", "Operator");
    expect(all("menuitemradio", undefined, operators).map((item) => item.textContent)).toEqual(["is any of", "is none of", "is empty", "is not empty"]);
    expect(document.activeElement).toBe(get("menuitemradio", "is any of", operators));
    click(get("menuitemradio", "is none of", operators));
    expect(changes).toHaveBeenLastCalledWith('!(category == "Software" || category == "Travel")');
    expect(document.activeElement).toBe(get("button", "is none of", pill("category is none of Software, Travel")));
  });

  it("edits a pill's operator and value where it stands", () => {
    const { changes } = setup("amount > 10 && paid == true");
    click(get("button", ">", pill("Amount > 10")));
    key("ArrowDown");
    key("Enter");
    expect(changes).toHaveBeenLastCalledWith("amount >= 10 && paid == true");
    click(get("button", "10", pill("Amount ≥ 10")));
    const value = get("textbox", "Value", get("dialog", "Edit value"));
    expect(document.activeElement).toBe(value);
    type(value, "25");
    key("Enter");
    expect(changes).toHaveBeenLastCalledWith("amount >= 25 && paid == true");
    expect(find("dialog")).toBeNull();
    expect(document.activeElement).toBe(get("button", "25", pill("Amount ≥ 25")));
    click(get("button", "true", pill("Paid is true")));
    click(get("button", "False", get("dialog", "Edit value")));
    expect(changes).toHaveBeenLastCalledWith("amount >= 25 && paid == false");
    click(get("button", "≥", pill("Amount ≥ 25")));
    click(get("menuitemradio", "is empty", get("menu", "Operator")));
    expect(changes).toHaveBeenLastCalledWith('(amount == null || amount == "") && paid == false');
    expect(find("button", "Choose value", pill("Amount is empty"))).toBeNull();
  });

  it("compares with one of the host's values in one press", () => {
    const { changes } = setup("date.year() == 2025");
    click(get("button", "2025", pill("Date year is 2025")));
    const editor = get("dialog", "Edit value");
    expect(get("textbox", "Value", editor).getAttribute("placeholder")).toBe("Year, e.g. 2026");
    click(get("button", /this\.fiscal_year/u, editor));
    expect(changes).toHaveBeenLastCalledWith("date.year() == this.fiscal_year");
    click(get("button", "this.fiscal_year", pill("Date year is this.fiscal_year")));
    expect(get("button", /this\.fiscal_year/u, get("dialog", "Edit value")).getAttribute("aria-pressed")).toBe("true");
  });

  it("takes a typed value on a press elsewhere, and gives it up on Escape", () => {
    const { changes } = setup("amount > 10");
    const open = () => {
      click(get("button", /^\d+$/u, pill(/^Amount >/u)));
      return get("textbox", "Value", get("dialog", "Edit value"));
    };
    type(open(), "25");
    key("Escape");
    expect(changes).not.toHaveBeenCalled();
    expect(find("dialog")).toBeNull();
    expect(document.activeElement).toBe(get("button", "10", pill("Amount > 10")));
    type(open(), "30");
    click(get("button", "Elsewhere"));
    expect(changes).toHaveBeenLastCalledWith("amount > 30");
    expect(find("dialog")).toBeNull();
  });

  it("turns a pill into an expression and back", () => {
    const { changes } = setup('status == "open" && amount > 10');
    click(get("button", "Amount", pill("Amount > 10")));
    click(get("menuitem", "Edit as expression", get("menu", "Filter options")));
    const editor = get("dialog", "Edit expression");
    const input = get("textbox", "CEL expression", editor) as HTMLTextAreaElement;
    expect(input.value).toBe("amount > 10");
    expect(document.activeElement).toBe(input);
    expect(changes).not.toHaveBeenCalled();
    expect(get("button", "Convert to filter", editor)).toBeTruthy();
    type(input, "amount * 1.54 > 1000");
    key("Enter");
    expect(changes).toHaveBeenLastCalledWith('status == "open" && amount * 1.54 > 1000');
    expect(find("dialog")).toBeNull();

    const code = get("button", "amount * 1.54 > 1000", pill("Expression amount * 1.54 > 1000"));
    expect(document.activeElement).toBe(code);
    click(code);
    const again = get("dialog", "Edit expression");
    expect(find("button", "Convert to filter", again)).toBeNull();
    type(get("textbox", "CEL expression", again), 'title.endsWith("Q1")');
    click(get("button", "Convert to filter", again));
    expect(changes).toHaveBeenLastCalledWith('status == "open" && endsWith(title, "Q1")');
    expect(document.activeElement).toBe(get("button", "Title", pill("Title ends with Q1")));
  });

  it("adds an expression from the list of fields", () => {
    const { changes, add } = setup("");
    const command = add();
    click(get("option", /Custom expression/u, command));
    type(get("textbox", "CEL expression", command), "size(tags) > 2");
    key("Enter");
    expect(changes).toHaveBeenLastCalledWith("size(tags) > 2");
    expect(pill("Expression size(tags) > 2")).toBeTruthy();
  });

  it("makes a nested group and edits it where it stands", () => {
    const { changes, add } = setup('status != "draft"');
    click(get("option", /Filter group/u, add()));
    const group = pill("Any group");
    const inner = get("dialog", "Add filter");
    expect(document.activeElement).toBe(get("combobox", "Filter by field", inner));
    click(get("option", "category", inner));
    click(get("checkbox", "Software", inner));
    expect(changes).toHaveBeenLastCalledWith('status != "draft" && category == "Software"');
    key("Escape");
    expect(document.activeElement).toBe(get("button", "Add filter to group", group));

    click(get("button", "Add filter to group", group));
    const second = get("dialog", "Add filter");
    type(get("combobox", "Filter by field", second), "amo");
    key("Enter");
    click(get("combobox", "Operator", second));
    click(get("option", "≥", second));
    type(get("textbox", "Value", second), "1000");
    key("Enter");
    expect(changes).toHaveBeenLastCalledWith('status != "draft" && (category == "Software" || amount >= 1000)');
    expect(pill("Amount ≥ 1000", group)).toBeTruthy();

    click(get("button", "Any", group));
    click(get("menuitemradio", /None/u, get("menu", "Match")));
    expect(changes).toHaveBeenLastCalledWith('status != "draft" && !(category == "Software" || amount >= 1000)');
    click(get("button", "Match all"));
    click(get("menuitemradio", /Match any/u, all("menu", "Match").at(-1)));
    expect(changes).toHaveBeenLastCalledWith('status != "draft" || !(category == "Software" || amount >= 1000)');
    click(get("button", "Remove group", pill("None group")));
    expect(changes).toHaveBeenLastCalledWith('status != "draft"');
    expect(document.activeElement).toBe(get("button", "Add filter"));
  });

  it("wraps a pill in a group of alternatives from its menu", () => {
    const { changes } = setup("amount > 10");
    click(get("button", ">", pill("Amount > 10")), { button: 2 });
    click(get("menuitem", "Wrap in “any” group", get("menu", "Filter options")));
    const inner = get("dialog", "Add filter");
    click(get("option", "Paid", inner));
    click(get("button", "True", inner));
    expect(changes).toHaveBeenLastCalledWith("amount > 10 || paid == true");
  });

  it("finds a field by typing, and adds a check for emptiness straight from the operator", () => {
    const { changes, add } = setup("amount > 10");
    const command = add();
    type(get("combobox", "Filter by field", command), "tit");
    expect(all("option", undefined, command).map((option) => option.querySelector(".mdbase-filter-option-label")!.textContent)).toEqual(["Title", "Custom expression", "Filter group"]);
    key("Enter");
    expect(get("combobox", "Operator", command).textContent).toBe("is");
    click(get("combobox", "Operator", command));
    click(get("option", "is empty", command));
    expect(changes).toHaveBeenLastCalledWith('amount > 10 && (title == null || title == "")');
    expect(find("dialog")).toBeNull();
  });

  it("opens on the list of fields when asked to", () => {
    setup("", { defaultOpen: true });
    expect(document.activeElement).toBe(get("combobox", "Filter by field", get("dialog", "Add filter")));
  });

  it("lets a locked field's filter be edited, but not removed or added again", () => {
    const { add } = setup('type == "expense" && paid == true', { lockedFields: ["type"] });
    const locked = pill("type is expense");
    expect(find("button", "type", locked)).toBeNull();
    expect(find("button", "Remove filter", locked)).toBeNull();
    expect((get("button", "expense", locked) as HTMLButtonElement).disabled).toBe(false);
    expect(find("option", "type", add())).toBeNull();
    key("Escape");
    expect(find("dialog")).toBeNull();
  });

  it("shows the filters every view applies beside the view's own, and moves a filter between them", () => {
    const { changes, sharedChanges, add } = setup("amount > 10", {}, 'type == "expense"');
    const shared = pill("Shared: type is expense");
    expect(shared.textContent).toContain("Shared");
    expect(find("button", /^Match/u)).toBeNull();
    click(get("button", "expense", shared));
    click(get("checkbox", "income", get("dialog", "Edit value")));
    expect(sharedChanges).toHaveBeenLastCalledWith('type == "expense" || type == "income"');
    expect(changes).not.toHaveBeenCalled();
    key("Escape");

    click(get("button", "Amount", pill("Amount > 10")));
    click(get("menuitem", /Move to shared/u, get("menu", "Filter options")));
    expect(changes).toHaveBeenLastCalledWith("");
    expect(sharedChanges).toHaveBeenLastCalledWith('(type == "expense" || type == "income") && amount > 10');
    click(get("button", "Amount", pill("Shared: Amount > 10")));
    click(get("menuitem", "Move to this view", all("menu", "Filter options").at(-1)));
    expect(changes).toHaveBeenLastCalledWith("amount > 10");
    expect(sharedChanges).toHaveBeenLastCalledWith('type == "expense" || type == "income"');

    const command = add();
    expect((get("radio", "This view", command) as HTMLInputElement).checked).toBe(true);
    click(get("radio", "Shared", command));
    click(get("option", "Paid", command));
    click(get("button", "False", command));
    expect(sharedChanges).toHaveBeenLastCalledWith('(type == "expense" || type == "income") && paid == false');
    expect(pill("Shared: Paid is false")).toBeTruthy();
  });

  it("shows why the query failed", () => {
    setup("amount > 10", { error: "Unknown field amount" });
    expect(get("alert").textContent).toBe("Unknown field amount");
  });

  it("shows the text a host passes in place of the shared catalogue's", () => {
    setup('amount > 10 && (category == "Software" || category == "Travel" || category == "Office")', {
      labels: {
        filters: "Filtres", addFilter: "Ajouter un filtre", filter: "Filtrer", matchAll: "Tous", isAnyOf: "est parmi",
        selected: (count) => `${String(count)} choisis`, removeFilter: "Retirer", operator: "Opérateur", isNoneOf: "n’est aucun de",
      },
    });
    expect(get("group", "Filtres")).toBeTruthy();
    expect(get("button", "Tous")).toBeTruthy();
    const multi = pill("category est parmi Software, Travel, Office");
    expect(names(all("button", undefined, multi))).toEqual(["category", "est parmi", "3 choisis", "Retirer"]);
    click(get("button", "est parmi", multi));
    expect(all("menuitemradio", undefined, get("menu", "Opérateur")).map((item) => item.textContent)).toEqual(["est parmi", "n’est aucun de", "is empty", "is not empty"]);
    key("Escape");
    expect(get("button", "Ajouter un filtre").textContent).toBe("Filtrer");
  });

  it("opens its panels in the top layer, outside a container that clips, and inside the viewport", () => {
    const showPopover = vi.spyOn(HTMLElement.prototype, "showPopover");
    const view = mount(
      <div style={{ width: 300, height: 120, overflow: "hidden" }}>
        <FilterBuilder query="amount > 10" fields={fields} onChange={() => undefined} />
      </div>,
    );
    click(get("button", "Add filter"));
    const dialog = get("dialog", "Add filter");
    expect(view.host.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.getAttribute("popover")).toBe("manual");
    expect(showPopover).toHaveBeenCalledTimes(1);
    // jsdom lays everything out at 0,0: the panel sits under its control and keeps the gutter.
    expect(dialog.style.top).toBe("6px");
    expect(dialog.style.left).toBe("8px");
    expect(dialog.style.maxHeight).not.toBe("");
    key("Escape");
    expect(find("dialog")).toBeNull();
    expect(document.activeElement).toBe(get("button", "Add filter"));
    showPopover.mockRestore();
  });
});
