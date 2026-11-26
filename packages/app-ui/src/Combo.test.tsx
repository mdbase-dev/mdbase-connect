// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { all, cleanup, click, find, get, key, mount, type } from "../test/dom.js";
import { Combo, type ComboProps } from "./Combo.js";

afterEach(cleanup);

const options = [{ value: "draft" }, { value: "final", detail: "3 records" }, { value: "in-review", label: "In review" }];

function show(props: Partial<ComboProps> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  mount(<><Combo label="stage" options={options} emptyMessage="Nothing matches." onCommit={onCommit} onCancel={onCancel} {...props} /><button type="button">Elsewhere</button></>);
  const field = get("combobox", "stage") as HTMLInputElement;
  return { field, onCommit, onCancel, rows: () => all("option").map((row) => row.textContent) };
}

describe("Combo", () => {
  it("lists its values, narrows them as text is typed, and hands back the one chosen", () => {
    const view = show();
    click(view.field);
    expect(view.rows()).toEqual(["draft", "final3 records", "In review"]);
    type(view.field, "rev");
    expect(view.rows()).toEqual(["In review"]);
    key("Enter");
    expect(view.onCommit).toHaveBeenCalledWith("in-review", false);
  });

  it("puts the value that starts with the text ahead of one that only holds it", () => {
    const view = show({ options: [{ value: "refinal" }, { value: "final" }] });
    type(view.field, "fin");
    expect(view.rows()).toEqual(["final", "refinal"]);
  });

  it("takes typed text that is none of its values when it has a name for that", () => {
    const view = show({ newLabel: "Use" });
    type(view.field, "shipped");
    expect(view.rows()).toEqual(["Use “shipped”"]);
    key("Enter");
    expect(view.onCommit).toHaveBeenCalledWith("shipped", true);
  });

  it("offers only its values without one, and says so when nothing matches", () => {
    const view = show();
    type(view.field, "shipped");
    expect(view.rows()).toEqual([]);
    expect(document.body.textContent).toContain("Nothing matches.");
    key("Enter");
    expect(view.onCommit).not.toHaveBeenCalled();
  });

  it("refuses text the host does not accept", () => {
    const view = show({ newLabel: "New property", accepts: (text) => /^[a-z]+$/u.test(text) });
    type(view.field, "2 much");
    expect(find("option")).toBeNull();
    type(view.field, "pages");
    expect(view.rows()).toEqual(["New property “pages”"]);
  });

  it("starts with the value it is given without searching for it", () => {
    const view = show({ value: "final" });
    expect(view.field.value).toBe("final");
    click(view.field);
    expect(view.rows()).toHaveLength(3);
  });

  it("gives the field up on Escape, and on leaving it", () => {
    const view = show({ newLabel: "Use" });
    type(view.field, "shipped");
    key("Escape");
    key("Escape");
    expect(view.onCancel).toHaveBeenCalledOnce();
    expect(view.onCommit).not.toHaveBeenCalled();
    expect(view.field.value).toBe("");
  });

  it("hands over what was typed when the field is left, where it is asked to", () => {
    const view = show({ newLabel: "Use", commitOnBlur: true, value: "draft" });
    type(view.field, "shipped");
    click(get("button", "Elsewhere"));
    expect(view.onCommit).toHaveBeenCalledWith("shipped", true);
    expect(view.onCancel).not.toHaveBeenCalled();
  });

  it("hands over nothing new when the text was left as it was", () => {
    const view = show({ newLabel: "Use", commitOnBlur: true, value: "draft" });
    click(view.field);
    click(get("button", "Elsewhere"));
    expect(view.onCommit).not.toHaveBeenCalled();
    expect(view.onCancel).toHaveBeenCalledOnce();
  });
});
