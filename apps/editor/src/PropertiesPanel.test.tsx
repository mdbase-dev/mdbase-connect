import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "@mdbase/connect";
import { describe, expect, it, vi } from "vitest";
import type { NoteDocument } from "./model";
import { PropertiesPanel } from "./PropertiesPanel";
import { schemaDateInputValue } from "./schema-date";

describe("typed note properties", () => {
  it("edits date and date-time strings with native pickers", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={eventNote} types={[eventType]} onClose={() => undefined} onSave={onSave} />);

    const eventDate = screen.getByLabelText("event_date value");
    const startsAt = screen.getByLabelText("starts_at value");
    expect(eventDate).toHaveAttribute("type", "date");
    expect(eventDate).toHaveValue("2026-07-21");
    expect(startsAt).toHaveAttribute("type", "datetime-local");
    expect((startsAt as HTMLInputElement).value).toContain(schemaDateInputValue("2026-07-21T05:15:30.000Z", "date-time"));
    expect(screen.getByLabelText("event_date property kind")).toBeDisabled();

    fireEvent.change(eventDate, { target: { value: "2026-07-23" } });
    fireEvent.change(startsAt, { target: { value: "2026-07-23T09:45:00" } });
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(onSave).toHaveBeenCalledWith({
      event_date: "2026-07-23",
      starts_at: new Date("2026-07-23T09:45:00").toISOString()
    });
  });

  it("edits schema-defined nested objects and lists without raw JSON", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={contactNote} types={[contactType]} onClose={() => undefined} onSave={onSave} />);

    await user.clear(screen.getByLabelText("display_name"));
    await user.type(screen.getByLabelText("display_name"), "Ada Byron");
    const contacts = screen.getByRole("group", { name: "contacts value" });
    await user.click(within(contacts).getByRole("button", { name: "Add item" }));
    const kinds = screen.getAllByLabelText("kind");
    const values = screen.getAllByLabelText("value");
    await user.selectOptions(kinds[1], "phone");
    await user.type(values[1], "+44 20 0000 0000");
    await user.click(screen.getByRole("button", { name: "Save properties" }));

    expect(onSave).toHaveBeenCalledWith({
      profile: { display_name: "Ada Byron" },
      contacts: [
        { kind: "email", value: "ada@example.com" },
        { kind: "phone", value: "+44 20 0000 0000" }
      ]
    });
  });
});

const eventType: CollectionTypeDescriptor = {
  name: "event",
  schema: {
    type: "object",
    properties: {
      event_date: { type: "string", format: "date" },
      starts_at: { type: "string", format: "date-time" }
    }
  },
  extensions: {}
};

const eventNote: NoteDocument = {
  path: "Events/planning.md",
  frontmatter: {
    event_date: "2026-07-21",
    starts_at: "2026-07-21T05:15:30.000Z"
  },
  raw_frontmatter: {
    event_date: "2026-07-21",
    starts_at: "2026-07-21T05:15:30.000Z"
  },
  body: "# Planning\n",
  types: ["event"],
  revision: "revision-1"
};

const contactType: CollectionTypeDescriptor = {
  name: "contact",
  schema: {
    type: "object",
    properties: {
      profile: {
        type: "object",
        required: ["display_name"],
        properties: { display_name: { type: "string" } }
      },
      contacts: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: { type: "string", enum: ["email", "phone"] },
            value: { type: "string" }
          }
        }
      }
    }
  },
  extensions: {}
};

const contactNote: NoteDocument = {
  path: "People/ada.md",
  frontmatter: {
    profile: { display_name: "Ada" },
    contacts: [{ kind: "email", value: "ada@example.com" }]
  },
  raw_frontmatter: {
    profile: { display_name: "Ada" },
    contacts: [{ kind: "email", value: "ada@example.com" }]
  },
  body: "# Ada\n",
  types: ["contact"],
  revision: "revision-2"
};
