import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionGateway } from "./model";

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
    await screen.findByDisplayValue("Untitled");
    await waitFor(async () => expect((await gateway.list()).length).toBe(5));
  });

  it("renders an explicit full-access explanation before authorization", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    disconnected.connection = () => null;
    render(<App gateway={disconnected} />);
    expect(await screen.findByText(/view, create, edit, move, validate, and delete/i)).toBeInTheDocument();
  });
});
