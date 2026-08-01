import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "@mdbase-dev/connect";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SchemaValueEditor, schemaInitialValue, schemaValueComplete } from "./SchemaValueEditor";

describe("recursive schema values", () => {
  it("builds initial nested values from required fields, defaults, constants, and list minimums", () => {
    expect(schemaInitialValue(contactSchema)).toEqual({
      profile: { display_name: "", visibility: "team" },
      contacts: [{ kind: "", value: "" }]
    });
  });

  it("checks required descendants and recursive list items", () => {
    expect(schemaValueComplete(contactSchema, {
      profile: { display_name: "Callum", visibility: "team" },
      contacts: [{ kind: "email", value: "callum@example.com" }]
    })).toBe(true);
    expect(schemaValueComplete(contactSchema, {
      profile: { display_name: "", visibility: "team" },
      contacts: [{ kind: "email", value: "callum@example.com" }]
    })).toBe(false);
    expect(schemaValueComplete(contactSchema, {
      profile: { display_name: "Callum", visibility: "team" },
      contacts: [{ kind: "email", value: "" }]
    })).toBe(false);
  });

  it("edits nested objects, adds optional fields, and appends list objects", async () => {
    const user = userEvent.setup();
    render(<ValueHarness />);

    await user.clear(screen.getByLabelText("display_name"));
    await user.type(screen.getByLabelText("display_name"), "Callum Alpass");

    const profile = screen.getByRole("group", { name: /profile/i });
    await user.click(within(profile).getByRole("button", { name: "Add optional field" }));
    await user.selectOptions(within(profile).getByRole("combobox", { name: "Optional field" }), "timezone");
    await user.click(within(profile).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("timezone"), "Australia/Melbourne");

    const contacts = screen.getByRole("group", { name: "Contacts" });
    await user.click(within(contacts).getByRole("button", { name: "Add item" }));
    const kinds = screen.getAllByLabelText("kind");
    const values = screen.getAllByLabelText("value");
    await user.selectOptions(kinds[1], "phone");
    await user.type(values[1], "+61 400 000 000");

    expect(JSON.parse(screen.getByTestId("value").textContent ?? "{}")).toEqual({
      profile: {
        display_name: "Callum Alpass",
        visibility: "team",
        timezone: "Australia/Melbourne"
      },
      contacts: [
        { kind: "email", value: "callum@example.com" },
        { kind: "phone", value: "+61 400 000 000" }
      ]
    });
  });

  it("places newly added optional fields where the add control was used", async () => {
    const user = userEvent.setup();
    render(<FieldOrderHarness />);

    const settings = screen.getByRole("group", { name: "Settings" });
    const existingField = within(settings).getByLabelText("required_middle");
    await user.click(within(settings).getByRole("button", { name: "Add optional field" }));
    await user.selectOptions(within(settings).getByRole("combobox", { name: "Optional field" }), "optional_before");
    await user.click(within(settings).getByRole("button", { name: "Add" }));

    const addedField = within(settings).getByLabelText("optional_before");
    const addTrigger = within(settings).getByRole("button", { name: "Add optional field" });
    expect(existingField.compareDocumentPosition(addedField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(addedField.compareDocumentPosition(addTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("field-order-value")).toHaveTextContent(
      JSON.stringify({ required_middle: "", optional_before: "" })
    );
  });

  it("resolves local JSON Schema references into readable controls", async () => {
    const user = userEvent.setup();
    expect(schemaInitialValue(bindingSchema)).toEqual({
      status: {
        completed_values: [""],
        default: ""
      }
    });

    render(<BindingHarness />);
    expect(screen.getByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByText("Completed Values")).toBeInTheDocument();
    expect(screen.getByText("Statuses that count as complete.")).toBeInTheDocument();

    const completedValues = screen.getByText("Completed Values").closest<HTMLElement>("fieldset")!;
    const removeCompletedValue = within(completedValues).getByRole("button", { name: "Remove completed_values item 1" });
    expect(removeCompletedValue).toBeDisabled();
    expect(removeCompletedValue).toHaveClass("icon-button", "inline-remove-button", "schema-remove-value");
    await user.type(screen.getByLabelText("completed_values item 1"), "done");
    await user.click(within(completedValues).getByRole("button", { name: "Add item" }));
    await user.type(screen.getByLabelText("completed_values item 2"), "cancelled");
    await user.type(screen.getByLabelText("default"), "open");

    expect(JSON.parse(screen.getByTestId("binding-value").textContent ?? "{}")).toEqual({
      status: {
        completed_values: ["done", "cancelled"],
        default: "open"
      }
    });
  });

  it("edits open-ended object maps without falling back to raw JSON", async () => {
    const user = userEvent.setup();
    render(<MapValueHarness />);

    expect(screen.queryByRole("textbox", { name: "organizations JSON value" })).not.toBeInTheDocument();
    expect(screen.getByText("No entries yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add entry" }));

    const key = screen.getByRole("textbox", { name: "organizations entry 1 key" });
    expect(key).toHaveValue("entry");
    await user.clear(key);
    await user.type(key, "acme");

    const organization = screen.getByRole("group", { name: "acme value" });
    expect(screen.getByRole("button", { name: "Remove acme" })).toHaveClass(
      "icon-button",
      "inline-remove-button",
      "schema-remove-value"
    );
    await user.click(within(organization).getByRole("button", { name: "Add optional field" }));
    await user.click(within(organization).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("name"), "Acme Corporation");

    expect(JSON.parse(screen.getByTestId("map-value").textContent ?? "{}")).toEqual({
      acme: { name: "Acme Corporation" }
    });
  });
});

function ValueHarness() {
  const [value, setValue] = useState<unknown>({
    profile: { display_name: "Callum", visibility: "team" },
    contacts: [{ kind: "email", value: "callum@example.com" }]
  });
  return <>
    <SchemaValueEditor name="contact" schema={contactSchema} value={value} required onChange={setValue} />
    <output data-testid="value">{JSON.stringify(value)}</output>
  </>;
}

function BindingHarness() {
  const [value, setValue] = useState<unknown>(() => schemaInitialValue(bindingSchema));
  return <>
    <SchemaValueEditor name="settings" schema={bindingSchema} rootSchema={bindingSchema} value={value} required onChange={setValue} />
    <output data-testid="binding-value">{JSON.stringify(value)}</output>
  </>;
}

function FieldOrderHarness() {
  const [value, setValue] = useState<unknown>({ required_middle: "" });
  return <>
    <SchemaValueEditor name="settings" schema={fieldOrderSchema} value={value} required onChange={setValue} />
    <output data-testid="field-order-value">{JSON.stringify(value)}</output>
  </>;
}

function MapValueHarness() {
  const [value, setValue] = useState<unknown>({});
  return <>
    <SchemaValueEditor name="organizations" schema={organizationMapSchema} value={value} onChange={setValue} />
    <output data-testid="map-value">{JSON.stringify(value)}</output>
  </>;
}

const contactSchema: JsonObject = {
  type: "object",
  required: ["profile", "contacts"],
  properties: {
    profile: {
      type: "object",
      required: ["display_name", "visibility"],
      properties: {
        display_name: { type: "string", minLength: 1 },
        visibility: { type: "string", const: "team" },
        timezone: { type: "string" }
      }
    },
    contacts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["email", "phone"] },
          value: { type: "string", minLength: 1 }
        }
      }
    }
  }
};

const bindingSchema: JsonObject = {
  type: "object",
  required: ["status"],
  properties: {
    status: { $ref: "#/$defs/statusPolicy" }
  },
  $defs: {
    nonEmptyString: {
      type: "string",
      minLength: 1
    },
    stringSet: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/nonEmptyString" }
    },
    statusPolicy: {
      type: "object",
      required: ["completed_values", "default"],
      properties: {
        completed_values: {
          ...({ $ref: "#/$defs/stringSet" } as JsonObject),
          description: "Statuses that count as complete."
        },
        default: { $ref: "#/$defs/nonEmptyString" }
      }
    }
  }
};

const fieldOrderSchema: JsonObject = {
  type: "object",
  required: ["required_middle"],
  properties: {
    optional_before: { type: "string" },
    required_middle: { type: "string" },
    optional_after: { type: "string" }
  }
};

const organizationMapSchema: JsonObject = {
  type: "object",
  propertyNames: { type: "string", minLength: 1 },
  additionalProperties: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 }
    },
    additionalProperties: false
  }
};
