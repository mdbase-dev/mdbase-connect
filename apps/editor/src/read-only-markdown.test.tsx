import { render, screen } from "./test/locale";
import { describe, expect, it } from "vitest";
import { ReadOnlyMarkdown } from "./read-only-markdown";

describe("inert structural renderer bounds", () => {
  it.each([
    ["nesting", "> ".repeat(100) + "deep"],
    ["node count", "*a* ".repeat(3000)],
    ["two-element code blocks", "```\nx\n```\n\n".repeat(1500)],
    ["source length", "plain ".repeat(10000)]
  ])("bounds %s independently and explicitly labels the excerpt", (_kind, source) => {
    render(<ReadOnlyMarkdown source={source} byteLength={new TextEncoder().encode(source).byteLength} />);
    const preview = screen.getByRole("region", { name: "Read-only Markdown preview" });
    expect(preview.querySelectorAll("*").length).toBeLessThan(2100);
    expect(preview).toHaveTextContent("Preview truncated for display. The whole verified original is available using Open original.");
  });

  it("renders empty and small documents without suggesting a truncated or editable original", () => {
    const view = render(<ReadOnlyMarkdown source="" byteLength={0} />);
    expect(screen.getByRole("region")).toHaveTextContent("Read-only Markdown preview");
    view.rerender(<ReadOnlyMarkdown source={"Title\n=====\n\n1. First\n2. Second\n\nInline `code`\n\n---"} byteLength={54} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Title");
    expect(screen.getByRole("list").tagName).toBe("OL");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(view.container.querySelector("code")).toHaveTextContent("code");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.queryByText(/Preview truncated/)).not.toBeInTheDocument();
    expect(view.container.querySelector("a,input,button,textarea,[contenteditable]")).toBeNull();
  });
});
