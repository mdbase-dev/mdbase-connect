import { fireEvent, render, screen } from "@testing-library/react";
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
