import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Broken(): never {
  throw new Error("broken render");
}

describe("AppErrorBoundary", () => {
  it("keeps an unrecoverable render failure actionable", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("needs to restart");
    expect(screen.getByRole("button", { name: "Reload editor" })).toBeInTheDocument();
  });
});
