import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionGateway, NoteDocument } from "./model";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) =>
    <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />
}));

describe("mdbase editor", () => {
  it("opens a collection, selects a note, and autosaves body changes", async () => {
    const gateway = new DemoCollectionGateway(12);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.type(body, "\nA saved sentence.");
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument(), { timeout: 2_000 });

    const first = (await gateway.list())[0];
    const saved = await gateway.read(first.path);
    expect(saved.body).toContain("A saved sentence.");
  });

  it("creates a note and exposes collection-wide navigation", async () => {
    const gateway = new DemoCollectionGateway(4);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    await user.type(title, "A useful note");
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("Notes/A useful note.md");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "note");
    await user.click(screen.getByRole("button", { name: "Create note" }));
    expect(await screen.findByDisplayValue("A useful note")).toBeInTheDocument();
    await waitFor(async () => expect((await gateway.list()).length).toBe(5));
    const created = await gateway.read("Notes/A useful note.md");
    expect(created.raw_frontmatter?.title).toBe("A useful note");
    expect(created.body).toBe("");
  });

  it("keeps the note frame stable while a note is loading", async () => {
    const gateway = new SlowReadGateway();
    render(<App gateway={gateway} />);

    const loading = await screen.findByLabelText("Loading note");
    expect(loading).toHaveAttribute("aria-busy", "true");
    gateway.releaseRead();
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect(screen.queryByLabelText("Loading note")).not.toBeInTheDocument();
  });

  it("renders an explicit full-access explanation before authorization", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    disconnected.connection = () => null;
    render(<App gateway={disconnected} />);
    expect(await screen.findByText(/view, create, edit, move, validate, and delete/i)).toBeInTheDocument();
  });
});

class SlowReadGateway extends DemoCollectionGateway {
  private release?: () => void;

  constructor() {
    super(1);
  }

  override async read(path: string): Promise<NoteDocument> {
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.read(path);
  }

  releaseRead() {
    this.release?.();
  }
}
