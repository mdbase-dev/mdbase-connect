import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildToastItems, ToastStack } from "./Toasts";

afterEach(() => vi.useRealTimers());

describe("Undo notifications", () => {
  it("announces deletion, offers a focusable Undo and expires after six seconds even across rerenders", () => {
    vi.useFakeTimers();
    const undo = vi.fn(), dismiss = vi.fn();
    const items = () => buildToastItems({ recoveryMessage: "Deleted note.", recoveryBusy: false, onUndo: undo, hasPendingRename: false, onResumeRename: vi.fn() });
    const view = render(<ToastStack toasts={items()} onDismiss={dismiss} />);
    expect(screen.getByRole("status")).toHaveTextContent("Deleted note.");
    act(() => vi.advanceTimersByTime(3000));
    view.rerender(<ToastStack toasts={items()} onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(2999));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledWith("recovery");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
  });

  it("pauses while Undo has focus, and Escape dismisses without stealing focus", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<ToastStack toasts={[{ id: "undo", message: "Moved note.", tone: "success", action: { label: "Undo", onAction: vi.fn() } }]} onDismiss={dismiss} />);
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => vi.advanceTimersByTime(7000));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledWith("undo");
    expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
  });

  it("does not dismiss while a modal owns Escape or an Undo request is in flight", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<><div role="dialog" /><ToastStack toasts={[{ id: "undo", message: "Moving", tone: "success", action: { label: "Undoing", busy: true, onAction: vi.fn() } }]} onDismiss={dismiss} /></>);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.advanceTimersByTime(7000));
    expect(dismiss).not.toHaveBeenCalled();
  });
});
