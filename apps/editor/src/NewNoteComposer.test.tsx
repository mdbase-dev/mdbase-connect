import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "@mdbase/connect";
import { describe, expect, it, vi } from "vitest";
import { NewNoteComposer } from "./NewNoteComposer";

describe("new note schema fields", () => {
  it("uses date pickers and persists valid schema values", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[eventType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "event");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Planning session");
    const eventDate = screen.getByLabelText("event_date");
    const startsAt = screen.getByLabelText("starts_at");
    expect(eventDate).toHaveAttribute("type", "date");
    expect(startsAt).toHaveAttribute("type", "datetime-local");

    fireEvent.change(eventDate, { target: { value: "2026-07-22" } });
    fireEvent.change(startsAt, { target: { value: "2026-07-22T14:30:00" } });
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({
      title: "Planning session",
      path: "Events/Planning session.md",
      type: "event",
      titleField: "title",
      properties: {
        title: "Planning session",
        event_date: "2026-07-22",
        starts_at: new Date("2026-07-22T14:30:00").toISOString()
      }
    });
  });

  it("creates a folder through a normalized first-note path", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer purpose="folder" types={[]} onCreate={onCreate} onCancel={() => undefined} />);

    const create = screen.getByRole("button", { name: "Create folder" });
    expect(create).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "/Research/Ideas/");
    await user.type(screen.getByRole("textbox", { name: "First note" }), "Reading list");
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({
      title: "Reading list",
      path: "Research/Ideas/Reading list.md",
      type: undefined,
      titleField: undefined,
      properties: {}
    });
  });
});

const eventType: CollectionTypeDescriptor = {
  name: "event",
  definition: { match: { path_glob: "Events/**/*.md" } },
  schema: {
    type: "object",
    required: ["title", "event_date", "starts_at"],
    properties: {
      title: { type: "string" },
      event_date: { type: "string", format: "date" },
      starts_at: { type: "string", format: "date-time" }
    }
  },
  extensions: {}
};
