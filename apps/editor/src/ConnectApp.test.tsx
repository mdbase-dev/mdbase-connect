import { render, screen, waitFor } from "@testing-library/react";
import type { AccountData, ManagementOverview } from "@mdbase/connect-management";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectApp } from "./ConnectApp";

let overview: ManagementOverview;

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/connect?server=http%3A%2F%2F127.0.0.1%3A8787&collection=collection");
  overview = overviewFixture();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account/sessions") {
      return Response.json({ sessions: [] });
    }
    if (path === "/v1/account") {
      return Response.json(init?.method === "DELETE" ? { ok: true } : accountFixture());
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

  it("does not claim an enabled collection is connected when its computer is offline", async () => {
    overview.connectors[0].last_seen_at = new Date(Date.now() - 60_000).toISOString();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(screen.getByText("Open mdbase connect on Home computer to make this collection available.")).toBeInTheDocument();
    expect(screen.queryByText("The editor can reach this collection now.")).not.toBeInTheDocument();
  });

  it("keeps collection input open after a failed creation", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);
    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("button", { name: "All collections" }));
    await user.click(await screen.findByRole("button", { name: "New hosted collection" }));

    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/hosted/collections" && init?.method === "POST") {
        return Promise.resolve(Response.json({ error: { message: "Storage is temporarily unavailable." } }, { status: 503 }));
      }
      return originalFetch(input, init);
    });
    const input = screen.getByLabelText("Collection name");
    await user.clear(input);
    await user.type(input, "Field notes");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Storage is temporarily unavailable.");
    expect(input).toHaveValue("Field notes");
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
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
      created_at: now, revoked_at: null, revocation_status: "active", collection_id: "collection", collection_name: "Garden notes",
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

  it("keeps provider-pending revocations visible without claiming success", async () => {
    overview.grants = [{
      id: "grant", operations: ["read"],
      scope: { contracts: [], access: "full_collection" },
      created_at: new Date().toISOString(), revoked_at: new Date().toISOString(),
      revocation_status: "revoking", collection_id: "collection",
      collection_name: "Garden notes", collection_kind: "hosted",
      application_id: "app", application_name: "Photo catalog",
      distribution: "web", homepage: "https://photos.example",
      project_url: null, application_origin: "https://photos.example", icon: null
    }];
    const user = userEvent.setup();
    render(<ConnectApp />);

    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("button", { name: /Applications/ }));

    expect(await screen.findByText("Revoking…")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the hosted authority to confirm revocation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("keeps hosted storage, sign-in methods, and account deletion in the editor", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);

    await user.click(await screen.findByRole("button", { name: "Open account and sessions" }));
    expect(await screen.findByRole("heading", { name: "Hosted storage" })).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Permanent allowance")).toBeInTheDocument();
    expect(screen.getByText("10 MB of 1 GB")).toBeInTheDocument();
    expect(screen.getByText("4 KB Markdown · 10 MB files")).toBeInTheDocument();
    expect(screen.getByText("2 MB of 1 GB retained file storage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument();
    expect(screen.getByText("Local collection files stay on your computers and are not measured here.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete account…" }));
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete account permanently" }));

    expect(await screen.findByRole("heading", { name: "Your account has been deleted." })).toBeInTheDocument();
    expect(location.pathname).toBe("/connect/account-deleted");
    expect(screen.getByText(/local collection and mirror files remain/i)).toBeInTheDocument();
  });
});

function overviewFixture(): ManagementOverview {
  const now = new Date().toISOString();
  return {
    user: { id: "person", name: "Example Person", email: "person@example.com", login: null },
    subscription: {
      kind: "beta",
      profiles: ["beta_v1"],
      permanent: true,
      limits: {
        hosted_storage_bytes: 1_073_741_824,
        retained_file_bytes: 1_073_741_824,
        max_document_bytes: 2_097_152,
        max_single_file_bytes: 262_144_000,
        max_replicas_per_collection: 10,
        max_hosted_collections: 250,
        max_files_per_collection: 10_000
      },
      usage: {
        hosted_collections: 1,
        live_content_bytes: 4_096,
        live_file_bytes: 10_485_760,
        live_storage_bytes: 10_489_856,
        retained_file_bytes: 2_097_152
      },
      reconciliation: { entitlement_revision: 1, provider_revision: 1 }
    },
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

function accountFixture(): AccountData {
  return {
    user: { id: "person", name: "Example Person", email: "person@example.com", login: null },
    authentication: {
      managed: true,
      current_provider: "password",
      available_providers: { github: false, google: false, password: true },
      identities: [],
      password: {
        configured: true,
        email: "person@example.com",
        current: true,
        change_available: true
      }
    },
    storage: {
      status: "available",
      total_content_bytes: 4_096,
      total_file_bytes: 10_485_760,
      total_storage_bytes: 10_489_856,
      total_stored_file_bytes: 12_582_912,
      total_records: 2,
      collections: [{
        id: "hosted",
        display_name: "Hosted research",
        usage: {
          collection_id: "hosted",
          record_count: 2,
          content_bytes: 4_096,
          max_records: 100_000,
          max_content_bytes: 1_073_741_824,
          max_document_bytes: 2_097_152,
          file_count: 2,
          file_bytes: 10_485_760,
          stored_file_bytes: 12_582_912,
          max_files: 10_000,
          max_file_bytes: 1_073_741_824,
          max_stored_file_bytes: 2_147_483_648,
          max_single_file_bytes: 262_144_000
        }
      }]
    },
    deletion: {
      available: true,
      hosted_collections: 1,
      local_collections: 1,
      computers: 1,
      development_confirmation: true
    }
  };
}
