import { render, screen, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "@mdbase-dev/connect";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { StructuredPropertiesEditor } from "./StructuredPropertiesEditor";

describe("structured property selection controls", () => {
  it("keeps undeclared typed properties quiet without discarding or locking their values", async () => {
    const user = userEvent.setup();
    render(<AdditionalPropertyHarness />);
    expect(screen.getByRole("textbox", { name: "title value" })).toBeVisible();
    expect(screen.getByText("Additional properties").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("spinbutton", { name: "mobileRevision value" })).not.toBeVisible();
    await user.clear(screen.getByRole("textbox", { name: "title value" }));
    await user.type(screen.getByRole("textbox", { name: "title value" }), "Changed");
    expect(JSON.parse(screen.getByTestId("additional-value").textContent ?? "{}")).toEqual({ title: "Changed", mobileRevision: 4 });
    await user.click(screen.getByText("Additional properties"));
    expect(screen.getByRole("spinbutton", { name: "mobileRevision value" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "mobileRevision value" })).toHaveValue(4);
    expect(screen.getByRole("combobox", { name: "mobileRevision property type" })).toBeEnabled();
  });

  it("keeps string tags editable as chips for nullable list schemas", () => {
    render(<StructuredPropertiesEditor value={{ tags: ["kept"] }}
      contract={{ properties: { tags: { type: ["array", "null"], items: { type: "string" } } }, required: [] }} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Add tag" })).toBeVisible();
    expect(screen.getByLabelText("tags value item 1")).toHaveValue("kept");
  });

  it("keeps free-form properties visible when no type groups them", () => {
    render(<StructuredPropertiesEditor value={{ custom: "Kept" }} contract={{ properties: {}, required: [] }} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "custom value" })).toBeVisible();
    expect(screen.queryByText("Additional properties")).not.toBeInTheDocument();
  });
  it("uses the shared searchable picker for scalar and list record links", async () => {
    const user = userEvent.setup();
    const { container } = render(<LinkPropertyHarness />);

    expect(container.querySelector("datalist")).not.toBeInTheDocument();
    const related = screen.getByRole("combobox", { name: "related value" });
    await user.clear(related);
    await user.type(related, "People");
    const relatedSuggestions = screen.getByRole("listbox", { name: "related note suggestions" });
    await user.click(within(relatedSuggestions).getByRole("option", { name: "People/ada.md" }));
    expect(related).toHaveValue("People/ada.md");

    const reference = screen.getByRole("combobox", { name: "references value item 1" });
    await user.clear(reference);
    await user.type(reference, "Projects");
    const referenceSuggestions = screen.getByRole("listbox", { name: "references item suggestions" });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(reference).toHaveValue("Projects/alpha.md");
    expect(referenceSuggestions).not.toBeInTheDocument();

    expect(JSON.parse(screen.getByTestId("link-property-value").textContent ?? "{}")).toEqual({
      related: "People/ada.md",
      references: ["Projects/alpha.md"]
    });
  });
});

function AdditionalPropertyHarness() {
  const [value, setValue] = useState<JsonObject>({ title: "Original", mobileRevision: 4 });
  return <>
    <StructuredPropertiesEditor value={value} contract={{ required: [], properties: { title: { type: "string" } } }} groupUndeclared onChange={setValue} />
    <output data-testid="additional-value">{JSON.stringify(value)}</output>
  </>;
}

function LinkPropertyHarness() {
  const [value, setValue] = useState<JsonObject>({
    related: "People/grace.md",
    references: ["People/ada.md"]
  });
  return <>
    <StructuredPropertiesEditor
      value={value}
      contract={linkContract}
      recordPaths={["People/ada.md", "People/grace.md", "Projects/alpha.md"]}
      allowAdd={false}
      onChange={setValue}
    />
    <output data-testid="link-property-value">{JSON.stringify(value)}</output>
  </>;
}

const linkContract = {
  required: [],
  properties: {
    related: {
      type: "string",
      format: "mdbase-record-link"
    },
    references: {
      type: "array",
      items: {
        type: "string",
        format: "mdbase-record-link"
      }
    }
  }
};
