import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "@mdbase/connect";
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

    const contacts = screen.getByRole("group", { name: "contacts" });
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
