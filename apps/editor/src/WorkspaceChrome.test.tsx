import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { InspectorFrame, PathLabel, SaveIndicator } from "./WorkspaceChrome";

afterEach(() => vi.useRealTimers());

describe("inspector presentation", () => {
  it("keeps a desktop inspector in the workspace without a scrim or modal focus trap", () => {
    const view = render(<InspectorFrame overlay={false} label="Note properties" width={340} onClose={() => {}}><aside aria-label="Note properties"><input aria-label="Property" /></aside></InspectorFrame>);
    expect(view.container.querySelector(".inspector-dock")).toContainElement(screen.getByRole("complementary", { name: "Note properties" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.container.querySelector(".dialog-scrim")).toBeNull();
  });

  it.each(["Escape", "scrim"])("traps narrow inspector focus and restores it after %s dismissal", async (dismissal) => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <div id="root">
        <button onClick={() => setOpen(true)}>Show properties</button>
        {open && <InspectorFrame overlay label="Note properties" width={340} onClose={() => setOpen(false)}>
          <aside><button data-inspector-close onClick={() => setOpen(false)}>Close inspector</button><input aria-label="Property" /><button>Last action</button></aside>
        </InspectorFrame>}
      </div>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Show properties" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Note properties" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.getElementById("root")).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("root")!.inert).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close inspector" })).toHaveFocus());
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close inspector" })).toHaveFocus();
    if (dismissal === "Escape") await user.keyboard("{Escape}");
    else fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.getElementById("root")).not.toHaveAttribute("aria-hidden");
    expect(document.getElementById("root")!.inert).toBe(false);
  });

  it("focuses the modal frame while loading, then its first control when lazy content arrives", async () => {
    const view = render(<InspectorFrame overlay label="Note properties" width={340} onClose={() => {}}><p>Loading…</p></InspectorFrame>);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Note properties" })).toHaveFocus());
    view.rerender(<InspectorFrame overlay label="Note properties" width={340} onClose={() => {}}><button data-inspector-close>Close inspector</button><input aria-label="Property" /></InspectorFrame>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close inspector" })).toHaveFocus());
    const input = screen.getByRole("textbox", { name: "Property" });
    input.focus();
    view.rerender(<InspectorFrame overlay label="Note properties" width={340} onClose={() => {}}><button data-inspector-close>Close inspector</button><input aria-label="Property" /><p>More information</p></InspectorFrame>);
    expect(input).toHaveFocus();
  });

  it("delegates modal dismissal to the panel close action so pending source saves can finish", async () => {
    const closePanel = vi.fn();
    const fallback = vi.fn();
    render(<InspectorFrame overlay label="Note properties" width={340} onClose={fallback}><button data-inspector-close onClick={closePanel}>Save and close</button></InspectorFrame>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closePanel).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Note properties" })).toBeInTheDocument();
  });
});

describe("quiet save status", () => {
  it("stays silent when healthy, waiting, or saving quickly", () => {
    vi.useFakeTimers();
    const view = render(<SaveIndicator state="saved" />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<SaveIndicator state="waiting" />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<SaveIndicator state="saving" />);
    act(() => vi.advanceTimersByTime(1_499));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<SaveIndicator state="saved" />);
    act(() => vi.advanceTimersByTime(2_000));
    expect(view.container).toBeEmptyDOMElement();
  });

  it.each(["saving", "properties"] as const)("delays %s feedback and resets it on navigation", (activity) => {
    vi.useFakeTimers();
    const view = render(<SaveIndicator state="saving" activity={activity} identity="one" />);
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    view.rerender(<SaveIndicator state="saving" activity={activity} identity="two" />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(1_499));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<SaveIndicator state="saved" identity="two" />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows errors, conflict and recovery immediately with relevant actions", () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    const view = render(<SaveIndicator state="error" activity="saving" onRetry={retry} />);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<SaveIndicator state="conflict" onRetry={retry} />);
    expect(screen.queryByRole("button", { name: "Retry save" })).not.toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    view.rerender(<SaveIndicator state="recovery" />);
    expect(screen.getByText("Recovery pending")).toBeInTheDocument();
    view.rerender(<SaveIndicator state="saved" activity="renaming" detail="Updating linked notes" onCancel={cancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it("keeps the filename separate from the shrinkable directory, including root paths", () => {
  const path = "Notes/A long directory/A deeper directory/Visible filename.md";
  const view = render(<PathLabel path={path} />);
  expect(view.container.querySelector(".path-directory")).toHaveTextContent("Notes/A long directory/A deeper directory/");
  expect(view.container.querySelector(".path-filename")).toHaveTextContent("Visible filename.md");
  expect(screen.getByTitle(path)).toHaveTextContent(path);
  view.rerender(<PathLabel path="Root.md" />);
  expect(view.container.querySelector(".path-directory")).toBeNull();
  expect(view.container.querySelector(".path-filename")).toHaveTextContent("Root.md");
});
