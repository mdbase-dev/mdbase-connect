import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MdbaseMark } from "./Brand";
import { OpeningScreen } from "./LoadingScreens";

describe("mdbase motion mark", () => {
  it("keeps the canonical segments and clipped conveyor in one SVG", () => {
    const { container } = render(<MdbaseMark motion="bootstrap" />);
    const mark = container.querySelector("svg");

    expect(mark).toHaveClass("mdbase-motion-bootstrap");
    expect(mark?.querySelectorAll(".mdbase-mark-segment")).toHaveLength(10);
    expect(mark?.querySelectorAll(".mdbase-mark-conveyor-track rect")).toHaveLength(10);
    expect(mark?.querySelector("clipPath rect")).toHaveAttribute("width", "76");
  });

  it("uses a stable editor wordmark while opening a collection", () => {
    const { container } = render(<OpeningScreen />);

    expect(screen.getByLabelText("Opening collection")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Opening collection");
    expect(container.querySelector(".wordmark .mdbase-motion-mark")).toBeInTheDocument();
    expect(container.querySelector(".wordmark [class*='mdbase-motion-unfold']")).not.toBeInTheDocument();
  });
});
