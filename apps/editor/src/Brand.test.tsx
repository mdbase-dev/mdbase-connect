import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
