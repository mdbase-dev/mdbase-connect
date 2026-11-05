import { fireEvent, render, screen } from "./test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePortalCommands } from "./portal-commands";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }));

describe("Portal keyboard scope", () => {
  const create = vi.fn();
  const navigate = vi.fn();
  function Host({ enabled = true }: { enabled?: boolean }) {
    const keyboard = usePortalCommands({ data: undefined, collections: [], applications: [], sessions: undefined, selectedCollectionId: undefined, navigate, viewLabel: view => view, enabled, openEditor: undefined, reviewRequest: undefined });
    return <><input aria-label="Filter" /><div contentEditable aria-label="Editor" />
      <main className="connect-main"><button data-command="create" onClick={create}>Create</button></main>
      {keyboard.open && <dialog open aria-label="Commands" />}
      {keyboard.helpOpen && <dialog open aria-label="Keyboard shortcuts" />}
    </>;
  }

  it("creates or navigates from the same registry and expires the navigation prefix", () => {
    const host = render(<Host />);
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(create).toHaveBeenCalledTimes(1);
    navigate.mockClear();
    fireEvent.keyDown(document.body, { key: "g" });
    host.rerender(<Host />);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(navigate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "g" });
    clock.mockReturnValue(1200);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each(["input", "editor", "dialog", "composition", "repeat", "alt"])("does not run commands during %s", kind => {
    create.mockClear();
    render(<Host />);
    const target = kind === "input" ? screen.getByRole("textbox", { name: "Filter" }) : kind === "editor" ? screen.getByLabelText("Editor") : document.body;
    if (kind === "dialog") document.body.appendChild(document.createElement("dialog")).setAttribute("open", "");
    fireEvent.keyDown(target, { key: "c", isComposing: kind === "composition", repeat: kind === "repeat", altKey: kind === "alt" });
    expect(create).not.toHaveBeenCalled();
    if (kind === "dialog") document.body.querySelector("dialog")?.remove();
  });

  it.each([{ key: "?" }, { key: "/", ctrlKey: true }])("opens help with $key", key => {
    render(<Host />);
    fireEvent.keyDown(document.body, key);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("opens the palette with Mod+K from an input and binds no single key to sign out or revoke", () => {
    create.mockClear(); navigate.mockClear();
    render(<Host />);
    fireEvent.keyDown(document.body, { key: "s" });
    fireEvent.keyDown(document.body, { key: "r" });
    expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Filter" }), { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeInTheDocument();
  });

  it("stays disabled before the overview is available", () => {
    render(<Host enabled={false} />);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reopens a retained palette instead of closing it again", () => {
    render(<Host />);
    const leaving = document.body.appendChild(document.createElement("dialog"));
    leaving.className = "mdbase-command-palette";
    leaving.open = true;
    leaving.dataset.open = "false";
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeInTheDocument();
    leaving.remove();
  });
});
