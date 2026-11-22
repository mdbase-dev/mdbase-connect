import { render, screen } from "./test/locale";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it, vi } from "vitest";
import { beginNewNote, type NewNote } from "./new-note";
import { QuickCreateRecord } from "./QuickCreateRecord";

const book: CollectionTypeDescriptor = {
  name: "book",
  path: "_mdbase/types/book.md",
  definition: {},
  schema: {
    type: "object",
    required: ["title", "isbn", "year"],
    properties: { title: { type: "string", minLength: 1 }, isbn: { type: "string" }, year: { type: "integer" }, notes: { type: "string" } }
  },
  collection: { display: { name_field: "title" } },
  extensions: {}
};

function open(onCreate = vi.fn<(note: NewNote) => void>()) {
  render(<QuickCreateRecord note={beginNewNote({ type: "book", title: "Dune" }, [book])} types={[book]}
    anchor={() => new DOMRect(40, 40, 200, 24)} onCreate={onCreate} onClose={vi.fn()} />);
  return { onCreate };
}

describe("a record made while linking to it", () => {
  it("asks for the name and only what the type requires, and is made once that is filled in", async () => {
    const user = userEvent.setup();
    const { onCreate } = open();

    const form = screen.getByRole("dialog", { name: "New book" });
    expect(form).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Dune");
    expect(screen.queryByText("notes")).not.toBeInTheDocument();
    // The name is typed already: the first required property takes the keyboard.
    const isbn = screen.getByRole("textbox", { name: "isbn value" });
    expect(isbn).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create and link" })).toBeDisabled();

    await user.type(isbn, "978-0441172719");
    await user.type(screen.getByRole("spinbutton", { name: "year value" }), "1965");
    await user.clear(screen.getByRole("textbox", { name: "Title" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Dune Messiah");
    await user.click(screen.getByRole("button", { name: "Create and link" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ type: "book", title: "Dune Messiah", properties: { isbn: "978-0441172719", year: 1965 } });
  });
});
