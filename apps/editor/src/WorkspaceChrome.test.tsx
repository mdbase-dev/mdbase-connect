import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PathLabel, SaveIndicator } from "./WorkspaceChrome";

afterEach(() => vi.useRealTimers());

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
