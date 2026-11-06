import { act, render, screen } from "./test/locale";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { describe, expect, it, vi } from "vitest";
import { OpeningScreen } from "./LoadingScreens";

describe("editor wordmark", () => {
  it("paints the shell while collection data loads, without a timed entrance", () => {
    const { container } = render(<OpeningScreen />);

    expect(screen.getByLabelText("Opening collection")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Reading its notes and types");
    expect(screen.getByRole("heading", { name: "All notes" })).toBeInTheDocument();
    for (const name of ["Back to notes", "New note", "More note actions"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(container.querySelector(".collection-rail .wordmark")).toBeInTheDocument();
    expect(container.querySelector(".note-list-pane")).toBeInTheDocument();
    expect(container.querySelector(".mdbase-opening-launch")).not.toBeInTheDocument();
  });
});

describe("mark entrance", () => {
  it("plays once, even when a loop hands back to it", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<MdbaseMark motion="keys-first" />);
      expect(container.querySelector(".mdbase-motion-keys-first")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(1300); });
      expect(container.querySelector(".mdbase-mark-at-rest")).toBeInTheDocument();

      rerender(<MdbaseMark motion="stream" />);
      expect(container.querySelector(".mdbase-motion-stream")).toBeInTheDocument();
      rerender(<MdbaseMark motion="keys-first" />);
      expect(container.querySelector(".mdbase-motion-keys-first")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
