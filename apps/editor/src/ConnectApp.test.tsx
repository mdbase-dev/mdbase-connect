import { render, screen, waitFor } from "@testing-library/react";
import type { ManagementOverview } from "@mdbase/connect-management";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectApp } from "./ConnectApp";

let overview: ManagementOverview;

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/connect?server=http%3A%2F%2F127.0.0.1%3A8787&collection=collection");
  overview = overviewFixture();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account/sessions") {
      return Response.json({ sessions: [] });
    }
    return Response.json(overview);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("ConnectApp", () => {
  it("opens account management without requesting a collection grant", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(calls).toEqual(expect.arrayContaining(["/v1/me", "/v1/account/sessions"]));
    expect(calls.some((path) => path.includes("authorization"))).toBe(false);

    await user.click(screen.getByRole("button", { name: /Applications/ }));
    await waitFor(() => expect(location.pathname).toBe("/connect/applications"));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeInTheDocument();
  });

  it("keeps Connect inside the editor collection shell", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    const collectionNavigation = screen.getByRole("complementary", { name: "Collection navigation" });
    expect(collectionNavigation).toHaveTextContent("Notes");
    expect(collectionNavigation).toHaveTextContent("Types");
    expect(collectionNavigation).toHaveTextContent("Settings");
    expect(collectionNavigation).toHaveTextContent("Manage");
    expect(screen.getByRole("link", { name: /Connect/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("complementary", { name: "Product navigation" })).not.toBeInTheDocument();
    expect(screen.getByText("This collection")).toBeInTheDocument();
    expect(screen.getByText("Account", { selector: "p" })).toBeInTheDocument();

    const notes = screen.getByRole("link", { name: "Notes" });
    expect(new URL(notes.getAttribute("href")!).searchParams.get("collection")).toBe("collection");

    await user.click(screen.getByRole("button", { name: "Storage & sync" }));
    await waitFor(() => expect(location.pathname).toBe("/connect/storage"));
    expect(screen.getByRole("heading", { name: "Storage & sync" })).toBeInTheDocument();
  });

  it("opens the only collection directly and records its context in the URL", async () => {
    history.replaceState(null, "", "/connect?server=http%3A%2F%2F127.0.0.1%3A8787");
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(location.search).get("collection")).toBe("collection"));
  });

  it("opens all collections when a direct entry has no unambiguous collection", async () => {
    overview.collections.push(secondCollection());
    history.replaceState(null, "", "/connect?server=http%3A%2F%2F127.0.0.1%3A8787");
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Collections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All collections" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(location.pathname).toBe("/connect/collections"));
    expect(new URLSearchParams(location.search).has("collection")).toBe(false);
  });

  it("restores the last selected collection on direct entry", async () => {
    overview.collections.push(secondCollection());
    localStorage.setItem("mdbase-connect:last-collection:http://127.0.0.1:8787", "collection-two");
    history.replaceState(null, "", "/connect?server=http%3A%2F%2F127.0.0.1%3A8787");
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Research notes" })).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(location.search).get("collection")).toBe("collection-two"));
  });

  it("shows each pending request once and describes application access plainly", async () => {
    const now = new Date().toISOString();
    overview.pending_authorizations = [{
      id: "request", flow: "authorization_code", requested_operations: ["read", "update"],
      collection_id: "collection", expires_at: now, application_id: "reading-list",
      application_name: "Reading list", distribution: "web", homepage: "https://reading.example",
      project_url: null, icon: null
    }];
    overview.grants = [{
      id: "grant", operations: ["read", "update"], scope: { contracts: [], access: "full_collection" },
      created_at: now, revoked_at: null, collection_id: "collection", collection_name: "Garden notes",
      collection_kind: "local", application_id: "reading-list", application_name: "Reading list",
      distribution: "web", homepage: "https://reading.example", project_url: null,
      application_origin: "https://reading.example", icon: null
    }];
    render(<ConnectApp />);

    expect(await screen.findByRole("link", { name: /Reading list is waiting.*Review request/ })).toBeInTheDocument();
    expect(screen.getAllByText("Reading list is waiting")).toHaveLength(1);
    expect(screen.getByText("Read and update records")).toBeInTheDocument();
    expect(screen.queryByText(/allowed actions/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "App access" })).not.toHaveTextContent("1");
  });
});

function overviewFixture(): ManagementOverview {
  const now = new Date().toISOString();
  return {
    user: { id: "person", name: "Example Person", email: "person@example.com", login: null },
    hosted_collections_available: true,
    authentication: { provider: "github", registration: "closed" },
    connectors: [{ id: "computer", name: "Home computer", last_seen_at: now, created_at: now }],
    collections: [{
      id: "collection", connector_id: "computer", local_id: "local", connector_name: "Home computer",
      display_name: "Garden notes", spec_version: "1", enabled: true, contracts: [], last_seen_at: now
    }],
    hosted_collections: [],
    grants: [],
    pending_authorizations: []
  };
}

function secondCollection(): ManagementOverview["collections"][number] {
  return {
    id: "collection-two", connector_id: "computer", local_id: "local-two", connector_name: "Home computer",
    display_name: "Research notes", spec_version: "1", enabled: true, contracts: [], last_seen_at: new Date().toISOString()
  };
}
