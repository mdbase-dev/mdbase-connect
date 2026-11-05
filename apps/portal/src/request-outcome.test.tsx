import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "./test/render";
import { RequestOutcome } from "./authorization-view";

afterEach(() => vi.useRealTimers());

it("waits for confirmed approval before counting down and cancels return on unmount", () => {
  vi.useFakeTimers();
  const replace = vi.fn();
  vi.stubGlobal("location", { ...location, replace });
  const view = render(<RequestOutcome status="setting_up" applicationName="Reader" returnUrl="/reader" />);
  act(() => vi.advanceTimersByTime(4_000));
  expect(replace).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Access approved" })).not.toBeInTheDocument();
  view.rerender(<RequestOutcome status="approved" applicationName="Reader" collectionName="Field notes" collectionKind="hosted" returnUrl="/reader" />);
  expect(screen.getByRole("heading", { name: "Reader can now use Field notes" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Return to Reader" })).toHaveAttribute("href", "/reader");
  expect(document.querySelector("output")).toHaveTextContent("3 seconds");
  act(() => vi.advanceTimersByTime(1_000));
  expect(document.querySelector("output")).toHaveTextContent("2 seconds");
  expect(replace).not.toHaveBeenCalled();
  view.unmount();
  act(() => vi.advanceTimersByTime(5_000));
  expect(replace).not.toHaveBeenCalled();
});

it("returns after three seconds, but never auto-returns a portable approval", () => {
  vi.useFakeTimers();
  const replace = vi.fn();
  vi.stubGlobal("location", { ...location, replace });
  const view = render(<RequestOutcome status="approved" applicationName="Reader" returnUrl="/reader" />);
  act(() => vi.advanceTimersByTime(2_999));
  expect(replace).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(replace).toHaveBeenCalledExactlyOnceWith("/reader");
  replace.mockClear();
  view.rerender(<RequestOutcome status="approved" applicationName="Reader" returnUrl="/reader" portable />);
  act(() => vi.advanceTimersByTime(5_000));
  expect(replace).not.toHaveBeenCalled();
  expect(document.querySelector("output")).toBeNull();
});
