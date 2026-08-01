import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "@mdbase-dev/connect";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { StructuredPropertiesEditor } from "./StructuredPropertiesEditor";

describe("structured property selection controls", () => {
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
