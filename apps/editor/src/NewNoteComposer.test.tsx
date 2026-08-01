import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it, vi } from "vitest";
import { NewNoteComposer } from "./NewNoteComposer";

describe("new note schema fields", () => {
  it("uses date pickers and persists valid schema values", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[eventType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "event");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Planning session");
    await user.click(screen.getByRole("textbox", { name: "Note body" }));
    await user.paste("Decide what ships next.");
    const eventDate = screen.getByLabelText("event_date value");
    const startsAt = screen.getByLabelText("starts_at value");
    expect(eventDate).toHaveAttribute("type", "date");
    expect(startsAt).toHaveAttribute("type", "datetime-local");

    fireEvent.change(eventDate, { target: { value: "2026-07-22" } });
    fireEvent.change(startsAt, { target: { value: "2026-07-22T14:30:00" } });
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({
      title: "Planning session",
      body: "Decide what ships next.",
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
      body: "",
      path: "Research/Ideas/Reading list.md",
      type: undefined,
      titleField: undefined,
      properties: {}
    });
  });

  it("creates typed notes with required objects and lists of objects", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[contactType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "contact");
    await user.type(screen.getByRole("textbox", { name: "Display Name" }), "Ada Lovelace");
    await user.click(screen.getByRole("textbox", { name: "Note body" }));
    await user.paste("Met at the analytical engine meetup.");
    expect(screen.getByRole("button", { name: "Create note" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("kind"), "email");
    await user.type(screen.getByLabelText("value"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({
      title: "Ada Lovelace",
      body: "Met at the analytical engine meetup.",
      path: "People/Ada Lovelace.md",
      type: "contact",
      titleField: "/profile/display_name",
      properties: {
        profile: { display_name: "Ada Lovelace" },
        contacts: [{ kind: "email", value: "ada@example.com" }]
      }
    });
  });

  it("keeps type visible, collapses path editing, and includes a local body draft", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    const onDraftChange = vi.fn();
    render(<NewNoteComposer types={[eventType]} onCreate={onCreate} onCancel={() => undefined} onDraftChange={onDraftChange} />);

    expect(screen.getByRole("combobox", { name: "Type" })).toBeVisible();
    expect(screen.getByLabelText("Suggested path")).toHaveTextContent("Untitled.md");
    const pathDetails = screen.getByText("File path", { selector: "summary > span" }).closest("details");
    expect(pathDetails).not.toHaveAttribute("open");

    await user.click(screen.getByRole("textbox", { name: "Note body" }));
    await user.paste("A thought before the filing details.");
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByText("File path", { selector: "summary > span" }));
    expect(pathDetails).toHaveAttribute("open");

    await user.type(screen.getByRole("textbox", { name: "Title" }), "Fast capture");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note body" }), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: "Fast capture",
      body: "A thought before the filing details."
    })));
  });

  it("adds optional typed properties with the same structured field experience", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[optionalType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "note");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Typed draft");
    expect(screen.getByText("1 available")).toBeInTheDocument();

    await user.click(screen.getByText("Properties", { selector: "summary > span" }));
    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.click(screen.getByRole("button", { name: /status/i }));
    await user.selectOptions(screen.getByLabelText("status value"), "draft");
    expect(screen.getByText("1 set")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create note" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      properties: { title: "Typed draft", status: "draft" }
    })));
  });

  it("keeps a structured name property separate from the note title", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[jsContactType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "contact");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Ada Lovelace");
    expect(screen.getByRole("button", { name: "Create note" })).toBeDisabled();

    const name = screen.getByRole("group", { name: "name value" });
    await user.click(within(name).getByRole("button", { name: "Add optional field" }));
    await user.selectOptions(within(name).getByRole("combobox", { name: "Optional field" }), "full");
    await user.click(within(name).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("full"), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      titleField: undefined,
      properties: {
        "@type": "Card",
        version: "2.0",
        name: {
          "@type": "Name",
          full: "Ada Lovelace"
        }
      }
    })));
  });

  it("does not guess that a schema field is the note title", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[unmappedType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "unmapped");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "The document heading");
    await user.type(screen.getByLabelText("name value"), "A separate schema value");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({
      title: "The document heading",
      body: "",
      path: "The document heading.md",
      type: "unmapped",
      titleField: undefined,
      properties: { name: "A separate schema value" }
    });
  });

  it("uses the declared contact name and lets people add optional properties", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<NewNoteComposer types={[friendlyContactType]} onCreate={onCreate} onCancel={() => undefined} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "contact");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Ada Lovelace");
    expect(screen.queryByLabelText("name value")).not.toBeInTheDocument();

    await user.click(screen.getByText("Properties", { selector: "summary > span" }));
    expect(screen.getByLabelText("kind value")).toHaveDisplayValue("person");
    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.click(screen.getByRole("button", { name: /email/i }));
    await user.type(screen.getByLabelText("email value"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate).toHaveBeenCalledWith({
      title: "Ada Lovelace",
      body: "",
      path: "People/Ada Lovelace.md",
      type: "contact",
      titleField: "name",
      properties: {
        name: "Ada Lovelace",
        kind: "person",
        email: "ada@example.com"
      }
    });
  });
});

const eventType: CollectionTypeDescriptor = {
  name: "event",
  definition: { match: { path_glob: "Events/**/*.md" } },
  collection: { display: { name_field: "title" } },
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

const contactType: CollectionTypeDescriptor = {
  name: "contact",
  definition: { match: { path_glob: "People/**/*.md" } },
  collection: { display: { name_field: "/profile/display_name" } },
  schema: {
    type: "object",
    required: ["profile", "contacts"],
    properties: {
      profile: {
        type: "object",
        required: ["display_name"],
        properties: {
          display_name: { type: "string", minLength: 1 },
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
  },
  extensions: {}
};

const optionalType: CollectionTypeDescriptor = {
  name: "note",
  collection: { display: { name_field: "title" } },
  schema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      status: { type: "string", enum: ["draft", "done"], description: "The note workflow state." }
    }
  },
  extensions: {}
};

const unmappedType: CollectionTypeDescriptor = {
  name: "unmapped",
  definition: {},
  schema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 }
    }
  },
  extensions: {}
};

const jsContactType: CollectionTypeDescriptor = {
  name: "contact",
  collection: { display: { name_field: "name" } },
  schema: {
    type: "object",
    required: ["@type", "version", "name"],
    properties: {
      "@type": { const: "Card" },
      version: { const: "2.0" },
      name: {
        type: "object",
        required: [],
        properties: {
          "@type": { const: "Name" },
          components: { type: "array", items: { type: "string" } },
          full: { type: "string", minLength: 1 }
        },
        anyOf: [
          { required: ["components"] },
          { required: ["full"] }
        ],
        additionalProperties: false
      }
    },
    additionalProperties: false
  },
  extensions: {}
};

const friendlyContactType: CollectionTypeDescriptor = {
  name: "contact",
  definition: { match: { path_glob: "People/**/*.md" } },
  collection: { display: { name_field: "name" } },
  schema: {
    type: "object",
    allOf: [{ $ref: "#/$defs/contact" }],
    $defs: {
      contact: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Name", minLength: 1 },
          kind: { type: "string", enum: ["person", "organization"], default: "person" },
          email: { type: "string", format: "email" },
          phone: { type: "string" }
        }
      }
    }
  },
  extensions: {}
};
