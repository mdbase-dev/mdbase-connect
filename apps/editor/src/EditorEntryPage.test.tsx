import { describe, expect, it } from "vitest";
import { render, screen } from "./test/locale";
import { EditorEntryPage } from "./ConnectionScreens";
import { editorPortalUrl } from "./connect-endpoint";

describe("Editor entry recovery", () => {
  it.each(["https://connect.example.test", "http://127.0.0.1:4815", "http://localhost:4815", "http://[::1]:4815", "http://connect.test"])("accepts a Portal origin: %s", (origin) => {
    expect(editorPortalUrl(`?server=${encodeURIComponent(origin)}`)).toBe(origin);
  });
  it.each(["javascript:alert(1)", "file:///tmp/notes", "https://user:secret@connect.test", "https://connect.test/local/path", "not a URL"])("does not turn invalid input into a recovery link: %s", (origin) => {
    expect(editorPortalUrl(`?server=${encodeURIComponent(origin)}`)).toBeNull();
  });
  it("refuses ambiguous Portal origins", () => {
    expect(editorPortalUrl("?server=https://one.test&server=https://two.test")).toBeNull();
  });
  it("offers a real Portal destination without a demo", () => {
    render(<EditorEntryPage title="Cannot open this collection">Return to Collections.</EditorEntryPage>);
    expect(screen.getByRole("link", { name: "Back to mdbase Connect" })).toHaveAttribute("href", editorPortalUrl());
    expect(screen.getByText(`Connect server: ${editorPortalUrl()}`)).toBeInTheDocument();
  });
});
