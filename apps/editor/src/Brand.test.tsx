import { act, render, screen } from "./test/locale";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { describe, expect, it, vi } from "vitest";
import { OpeningScreen } from "./LoadingScreens";

describe("editor wordmark", () => {
  it("opens on the shared opening screen index.html paints, scanning the platform mark", () => {
    const { container } = render(<OpeningScreen />);

    expect(screen.getByRole("main", { name: "Opening collection" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Opening collectionReading notes and files");
    expect(container.querySelector(".mdbase-opening-mark .mdbase-mark.mdbase-motion-scan")).toBeInTheDocument();
    expect(container.querySelector(".mdbase-app-mark")).not.toBeInTheDocument();
    expect(container.querySelector(".mdbase-opening-name")).toHaveTextContent("mdbase editor");
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
