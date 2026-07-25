import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "@mdbase/connect";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TypeDocument } from "./model";
import { TypeInspector } from "./TypeBrowser";

describe("recursive type builder", () => {
  it("adds and edits nested object fields through the design view", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    expect(screen.getByDisplayValue("display_name")).toBeInTheDocument();
    const nestedGroup = screen.getByText("Nested fields").closest<HTMLElement>(".nested-field-group")!;
    await user.click(within(nestedGroup).getByRole("button", { name: "Add nested field" }));
    const added = screen.getByDisplayValue("field");
    await user.clear(added);
    await user.type(added, "timezone");
    await user.tab();
    const timezoneRow = screen.getByDisplayValue("timezone").closest<HTMLElement>(".visual-field-row")!;
    await user.click(within(timezoneRow).getByRole("checkbox", { name: "Required" }));

    const source = screen.getByTestId("source").textContent ?? "";
    expect(source).toContain("timezone:");
    expect(source).toContain("required:");
    expect(source).toContain("- timezone");
  });

  it("requires inline confirmation before replacing nested structure", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    await user.selectOptions(screen.getByRole("combobox", { name: "profile field kind" }), "string");
    const warning = screen.getByRole("alert");
    expect(within(warning).getByText(/removes nested fields/)).toBeInTheDocument();
    expect(screen.getByTestId("source")).toHaveTextContent("display_name:");

    await user.click(within(warning).getByRole("button", { name: "Convert field" }));
    expect(screen.getByTestId("source")).not.toHaveTextContent("display_name:");
    expect(screen.getByTestId("source")).toHaveTextContent(/profile:\s+type: string/);
  });

  it("keeps advanced matching visible and routes it to YAML", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={advancedMatchSource} />);
    expect(screen.getByText("This type also has advanced matching rules that remain in YAML.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open YAML" }));
    expect(screen.getByRole("textbox", { name: "person type YAML" })).toBeInTheDocument();
  });
});

function InspectorHarness({ source: initialSource = recursiveSource }: { source?: string }) {
  const [source, setSource] = useState(initialSource);
  return <>
    <TypeInspector
      type={typeDescriptor}
      document={{ ...typeDocument, document: initialSource }}
      source={source}
      notes={[]}
      creating={false}
      loading={false}
      saving={false}
      onSourceChange={setSource}
      onSave={vi.fn()}
      onRevert={vi.fn()}
      onCancel={vi.fn()}
      onCreate={vi.fn()}
      onBack={vi.fn()}
    />
    <output data-testid="source">{source}</output>
  </>;
}

const recursiveSource = `---
kind: mdbase.type
name: person
description: A person
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      profile:
        type: object
        additionalProperties: false
        properties:
          display_name:
            type: string
        required: [display_name]
---
`;

const advancedMatchSource = recursiveSource.replace("description: A person", `description: A person
match:
  path_glob: "People/**/*.md"
  fields_present: [profile]`);

const typeDescriptor: CollectionTypeDescriptor = {
  name: "person",
  path: "_types/person.md",
  description: "A person",
  schema: {
    type: "object",
    properties: {
      profile: {
        type: "object",
        properties: { display_name: { type: "string" } },
        required: ["display_name"]
      }
    }
  },
  extensions: {}
};

const typeDocument: TypeDocument = {
  name: "person",
  path: "_types/person.md",
  revision: "type-revision-1",
  document: recursiveSource
};
