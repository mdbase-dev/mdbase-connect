import { render, screen } from "./test/locale";
import { describe, expect, it } from "vitest";
import { ReadOnlyMarkdown } from "./read-only-markdown";

describe("inert structural renderer bounds", () => {
  it("uses excerpt reference text in peek without changing inert original previews or code", () => {
    const source = "Read [[Notes/other|Another note]] and [[Notes/plain#Heading]].\n\n![[Assets/image.svg|Image]]\n\n`[[literal]]`\n\n```\n![[code]]\n```";
    const view = render(<ReadOnlyMarkdown source={source} byteLength={source.length} previewTitle="Title" />);
    const preview = screen.getByRole("region");
    expect(preview).toHaveTextContent("Read Another note and plain.");
    expect(preview).not.toHaveTextContent("Assets/image.svg");
    expect(preview.querySelector("code")).toHaveTextContent("[[literal]]");
    expect(preview.querySelector("pre")).toHaveTextContent("![[code]]");
    view.rerender(<ReadOnlyMarkdown source={source} byteLength={source.length} />);
    expect(preview).toHaveTextContent("[[Notes/other|Another note]]");
    expect(preview.querySelector("a,img")).toBeNull();
  });
  it.each(["# Title\n\nBody", "Title\n=====\n\nBody"])("omits only a leading heading repeating the peek title: %s", (source) => {
    const view = render(<ReadOnlyMarkdown source={source} byteLength={source.length} previewTitle="Title" />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByText("Read-only Markdown preview")).not.toBeInTheDocument();
    expect(screen.getByRole("region")).toHaveTextContent("Body");
    view.rerender(<ReadOnlyMarkdown source={source} byteLength={source.length} previewTitle="Another title" />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
  });

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
