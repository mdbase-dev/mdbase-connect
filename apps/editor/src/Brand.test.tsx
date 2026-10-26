import { act, render, screen } from "./test/locale";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { describe, expect, it, vi } from "vitest";
import { OpeningScreen } from "./LoadingScreens";

describe("editor wordmark", () => {
  it("opens on the launch mark, scanning straight away where the flock cannot fly", () => {
    const { container } = render(<OpeningScreen />);

    expect(screen.getByLabelText("Opening collection")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Opening collection");
    // jsdom has no matchMedia, so the entrance is skipped rather than holding the app.
    expect(container.querySelector(".mdbase-opening-launch")).toHaveAttribute("data-entrance", "landed");
    expect(container.querySelector(".mdbase-opening-flock")).not.toBeInTheDocument();
    expect(container.querySelector(".mdbase-opening-launch-mark .mdbase-motion-scan")).toBeInTheDocument();
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
