import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectApp } from "./ConnectApp";

beforeEach(() => {
  history.replaceState(null, "", "/connect");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account/sessions") {
      return Response.json({ sessions: [] });
    }
    return Response.json({
      user: { id: "person", name: "Example Person", email: "person@example.com", login: null },
      hosted_collections_available: true,
      authentication: { provider: "github", registration: "closed" },
      connectors: [{ id: "computer", name: "Home computer", last_seen_at: new Date().toISOString(), created_at: new Date().toISOString() }],
      collections: [{
        id: "collection", connector_id: "computer", local_id: "local", connector_name: "Home computer",
        display_name: "Garden notes", spec_version: "1", enabled: true, contracts: [], last_seen_at: new Date().toISOString()
      }],
      hosted_collections: [],
      grants: [],
      pending_authorizations: []
    });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("ConnectApp", () => {
  it("opens account management without requesting a collection grant", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Your connections" })).toBeInTheDocument();
    expect(screen.getByText("Garden notes")).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(calls).toEqual(expect.arrayContaining(["/v1/me", "/v1/account/sessions"]));
    expect(calls.some((path) => path.includes("authorization"))).toBe(false);

    await user.click(screen.getByRole("button", { name: /Applications/ }));
    await waitFor(() => expect(location.pathname).toBe("/connect/applications"));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeInTheDocument();
  });
});
