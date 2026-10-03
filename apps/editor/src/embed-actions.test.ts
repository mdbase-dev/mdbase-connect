import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedActions, focusEmbedOnPointer } from "./embed-actions";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("embed actions", () => {
  it("opens the source and copies the exact path with accessible feedback", async () => {
    const open = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    document.body.append(embedActions("Notes/project.md", "Project", open));
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Copy path for Project" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Path copied."));
    expect(writeText).toHaveBeenCalledWith("Notes/project.md");
  });

  it("reports denied or unavailable clipboard access without an unhandled rejection", async () => {
    vi.stubGlobal("navigator", {});
    document.body.append(embedActions("Notes/project.md", "Project"));
    expect(screen.queryByRole("button", { name: "Open Project" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy path for Project" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn’t copy the path"));
  });

  it("focuses an embed on touch without stealing focus from its controls", () => {
    const region = document.createElement("figure");
    region.tabIndex = 0;
    focusEmbedOnPointer(region);
    region.append(embedActions("Assets/image.svg", "Image"));
    document.body.append(region);
    fireEvent.pointerDown(region);
    expect(region).toHaveFocus();
    const copy = screen.getByRole("button");
    copy.focus();
    fireEvent.pointerDown(copy);
    expect(copy).toHaveFocus();
  });
});
