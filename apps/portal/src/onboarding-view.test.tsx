import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "./test/render";
import { GettingStarted } from "./onboarding-view";

const replace = vi.fn();

beforeEach(() => {
  replace.mockReset();
  vi.stubGlobal("location", { ...location, replace });
});

describe("starter onboarding", () => {
  it.each([
    [409, "onboarding_moved"],
    [503, "starter_content_unavailable"],
    [409, "starter_unavailable"],
    [429, "account_collection_quota_exceeded"]
  ])("opens normal first-collection setup for %s %s without an error", async (status, code) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code, message: "Starter refused." } }, { status }));
    render(<GettingStarted />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/v1/onboarding/starter-collection", expect.objectContaining({ method: "POST" }));
  });

  it.each([
    [500, "internal_error"],
    [503, "service_unavailable"],
    [409, "unexpected_conflict"],
    [429, "rate_limited"],
    [500, "onboarding_moved"]
  ])("keeps the error and retry for unexpected %s %s", async (status, code) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code, message: "Could not prepare the collection." } }, { status }));
    render(<GettingStarted />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not prepare the collection.");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open mdbase Connect without it" })).toHaveAttribute("href", "/");
    vi.mocked(fetch).mockResolvedValue(Response.json({ status: "ready", editor_url: "https://editor.example.test/starter" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("https://editor.example.test/starter"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps network failures retryable", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    render(<GettingStarted />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection and try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("still opens a legacy starter in the editor after success", async () => {
    const editorUrl = "https://editor.example.test/starter";
    vi.mocked(fetch).mockResolvedValue(Response.json({ status: "ready", collection_id: "legacy-starter", editor_url: editorUrl }));
    render(<GettingStarted />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(editorUrl));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
