import { act, render, screen } from "@testing-library/react";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { describe, expect, it, vi } from "vitest";
import { OpeningScreen } from "./LoadingScreens";

describe("editor wordmark", () => {
  it("scans the editor wordmark while opening a collection", () => {
    const { container } = render(<OpeningScreen />);

    expect(screen.getByLabelText("Opening collection")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Opening collection");
    expect(container.querySelector(".wordmark .mdbase-mark")).toBeInTheDocument();
    expect(container.querySelector(".wordmark .mdbase-motion-scan")).toBeInTheDocument();
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
