import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, within } from "./test/render";
import { managedAppOrigins } from "../../../scripts/lib/managed-app-origins.mjs";
import { RequestOutcome } from "./authorization-view";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("names the return step without duplicating it, and gives a next step without a return URL", () => {
  const view = render(<RequestOutcome status="approved" applicationName="Reader" returnUrl="/reader" />);
  expect(screen.getByText("Returning to Reader…")).toBeInTheDocument();
  expect(screen.queryByText(/follow you back/)).not.toBeInTheDocument();
  expect(screen.queryByText("Continue in Reader to use this collection.")).not.toBeInTheDocument();
  view.rerender(<RequestOutcome status="approved" applicationName="Reader" />);
  expect(screen.getByText("Continue in Reader to use this collection.")).toBeInTheDocument();
  expect(screen.queryByText(/Returning to/)).not.toBeInTheDocument();
});

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
  expect(document.querySelector("output")).toHaveAttribute("aria-live", "polite");
  expect(document.querySelector("output")).toHaveClass("mdbase-visually-hidden");
  expect(document.querySelector(".request-return-countdown")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("heading", { name: "Reader can now use Field notes" })).toHaveFocus();
  act(() => vi.advanceTimersByTime(1_000));
  expect(document.querySelector("output")).toHaveTextContent("2 seconds");
  expect(screen.getByRole("heading", { name: "Reader can now use Field notes" })).toHaveFocus();
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

it("shows other official apps and MCP on approved receipts without auto-return", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  render(<RequestOutcome
    status="approved"
    applicationName="Reader"
    applicationOrigin="https://reader.mdbase.dev"
    collectionId="c-notes"
    collectionName="Field notes"
    collectionKind="hosted"
    origins={managedAppOrigins.production}
  />);

  const section = screen.getByRole("region", { name: "Also works with Field notes" });
  expect(within(section).getAllByRole("link", { name: /^Open / }).map((link) => link.getAttribute("href"))).toEqual([
    "https://editor.mdbase.dev/?collection=c-notes",
    "https://writer.mdbase.dev/?collection=c-notes",
    "https://journal.mdbase.dev/?collection=c-notes",
    "https://app.tasknotes.dev/?collection=c-notes"
  ]);
  for (const link of within(section).getAllByRole("link")) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(within(section).getByText("Claude, ChatGPT & Codex")).toBeInTheDocument();
  expect(within(section).getByText("https://mcp.mdbase.dev/mcp")).toBeInTheDocument();
  expect(within(section).getByRole("link", { name: "Set up" })).toHaveAttribute("href", "https://mdbase.dev/apps/mcp/");
  expect(within(section).getByText("Each app asks for your approval before accessing Field notes. Your files remain ordinary Markdown.")).toBeInTheDocument();

  await user.click(within(section).getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("https://mcp.mdbase.dev/mcp");
  expect(within(section).getByRole("button", { name: "Copied" })).toBeInTheDocument();
});

it("shows app discovery for portable approvals even with a return URL, and hides it when auto-returning or on custom servers", () => {
  const view = render(<RequestOutcome
    status="approved"
    applicationName="Reader"
    collectionId="c-notes"
    collectionName="Field notes"
    returnUrl="/reader"
    origins={managedAppOrigins.production}
  />);
  expect(screen.queryByRole("region", { name: "Also works with Field notes" })).not.toBeInTheDocument();

  view.rerender(<RequestOutcome
    status="approved"
    applicationName="Reader"
    collectionId="c-notes"
    collectionName="Field notes"
    returnUrl="/reader"
    portable
    origins={managedAppOrigins.production}
  />);
  expect(screen.getByRole("region", { name: "Also works with Field notes" })).toBeInTheDocument();

  view.rerender(<RequestOutcome
    status="approved"
    applicationName="Reader"
    collectionId="c-notes"
    collectionName="Field notes"
    portable
  />);
  expect(screen.queryByRole("region", { name: "Also works with Field notes" })).not.toBeInTheDocument();

  view.rerender(<RequestOutcome
    status="denied"
    applicationName="Reader"
    collectionId="c-notes"
    collectionName="Field notes"
    origins={managedAppOrigins.production}
  />);
  expect(screen.queryByRole("region", { name: "Also works with Field notes" })).not.toBeInTheDocument();
});

it("omits the MCP row when MCP itself was just approved", () => {
  render(<RequestOutcome
    status="approved"
    applicationName="Claude"
    applicationOrigin="https://mcp.mdbase.dev"
    collectionId="c-notes"
    collectionName="Field notes"
    origins={managedAppOrigins.production}
  />);

  const section = screen.getByRole("region", { name: "Also works with Field notes" });
  expect(within(section).getAllByRole("link", { name: /^Open / })).toHaveLength(5);
  expect(within(section).queryByText("Claude, ChatGPT & Codex")).not.toBeInTheDocument();
});

it("cancels automatic return and ignores repeat clicks once the user clicks the return link", () => {
  vi.useFakeTimers();
  const replace = vi.fn();
  vi.stubGlobal("location", { ...location, replace });
  render(<RequestOutcome status="approved" applicationName="Reader" returnUrl="/reader" />);
  const link = screen.getByRole("link", { name: "Return to Reader" });
  expect(fireEvent.click(link)).toBe(true);
  expect(fireEvent.click(link)).toBe(false);
  act(() => vi.advanceTimersByTime(5_000));
  expect(replace).not.toHaveBeenCalled();
});
