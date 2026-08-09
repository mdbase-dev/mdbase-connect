import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";

describe("rendered Markdown links", () => {
  it("opens a rendered link without moving the caret into its source", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CodeEditor
      value={"Start here.\nRead [the documentation](https://mdbase.dev/docs/)."}
      label="Note body"
      language="markdown"
      variant="writer"
    />);

    const link = await screen.findByRole("link", { name: "the documentation" });
    expect(fireEvent.mouseDown(link)).toBe(false);
    fireEvent.click(link);

    expect(open).toHaveBeenCalledWith("https://mdbase.dev/docs/", "_blank", "noopener,noreferrer");
    expect(screen.getByRole("link", { name: "the documentation" })).toBeInTheDocument();
  });
});
