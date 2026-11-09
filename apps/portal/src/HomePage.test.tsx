import { render, screen, within } from "./test/render";
import type { ManagementOverview } from "@mdbase/connect-management";
import { describe, expect, it, vi } from "vitest";
import { managedAppOrigins } from "../../../scripts/lib/managed-app-origins.mjs";
import { applicationGroups } from "./ApplicationAccess";
import { HomePage } from "./HomePage";

type Grant = ManagementOverview["grants"][number];
type Installation = NonNullable<ManagementOverview["installation_access"]>[number];

function grant(id: string, name: string, homepage: string, collection: { id: string; name: string }, family?: string): Grant {
  return {
    id, operations: ["read"], scope: { contracts: [], access: "full_collection" }, created_at: "2026-01-01T00:00:00Z",
    revoked_at: null, revocation_status: "active", reauthorization_required_at: null, reauthorization_reason: null,
    collection_id: collection.id, collection_name: collection.name, collection_kind: "hosted",
    application_id: id, application_family_id: family, application_name: name, distribution: "web",
    homepage, project_url: null, application_origin: new URL(homepage).origin, icon: null
  };
}

function installation(name: string, origin: string, collection: { id: string; name: string }): Installation {
  return {
    application_id: `${name}-revision`, application_family_id: name.toLowerCase(), application_name: name, application_origin: origin,
    icon: null, connector_id: `${name}-connector`, installation_id: `${name}-installation`, device_kind: "app-runtime",
    created_at: "2026-01-01T00:00:00Z", create_collections: false, collection_id: collection.id, collection_name: collection.name,
    sync: "cloud_copy", available: true, role: "owner", approved_optional_file_actions: []
  };
}

const notes = { id: "notes", name: "Garden notes" };
const tasks = { id: "tasks", name: "Tasks" };
const collections = [
  { id: "notes", name: "Garden notes", status: "", detail: "Cloud copy" },
  { id: "tasks", name: "Tasks", status: "Connected", detail: "Home computer" }
];

function renderHome({ grants = [], installations = [], pending = [], origins, rows = collections }: {
  grants?: Grant[];
  installations?: Installation[];
  pending?: string[];
  /** A managed environment's origins, or null for a custom server. */
  origins?: typeof managedAppOrigins.production | null;
  rows?: typeof collections;
}) {
  const navigate = vi.fn();
  render(<HomePage
    data={{ pending_authorizations: pending.map((name) => ({ application_name: name })) as ManagementOverview["pending_authorizations"] }}
    collections={rows}
    applications={applicationGroups(grants, installations)}
    origins={origins === null ? undefined : origins ?? managedAppOrigins.production}
    navigate={navigate}
  />);
  return navigate;
}

describe("HomePage", () => {
  it("lists approved apps in order and suggests the official apps not yet used", () => {
    renderHome({
      grants: [
        grant("editor", "Editor", "https://editor.mdbase.dev/", notes),
        grant("board", "Board", "https://board.example/", tasks)
      ],
      installations: [installation("TaskNotes", "https://app.tasknotes.dev", tasks)],
      pending: ["Journal"]
    });

    const yours = screen.getByRole("region", { name: "Your apps" });
    expect(within(yours).getAllByRole("listitem").map((item) => item.querySelector("strong")!.textContent)).toEqual(["Board", "Editor", "TaskNotes"]);
    const editor = within(yours).getByRole("link", { name: "Open Editor" });
    expect(editor).toHaveAttribute("href", "https://editor.mdbase.dev/");
    expect(editor).toHaveAttribute("target", "_blank");
    expect(editor).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(yours).getByRole("link", { name: "Open TaskNotes" })).toHaveAttribute("href", "https://app.tasknotes.dev");
    expect(within(yours).getByText("Garden notes")).toBeInTheDocument();

    // Journal waits for approval, so only Reader and Writer are suggested.
    const more = screen.getByRole("region", { name: "More apps from mdbase" });
    expect(within(more).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["https://reader.mdbase.dev", "https://writer.mdbase.dev"]);
    expect(within(more).getByText("Read and annotate sources")).toBeInTheDocument();

    const summary = screen.getByRole("region", { name: "Collections" });
    expect(within(summary).getByRole("link", { name: /Garden notes/ })).toHaveTextContent("Editor");
    expect(within(summary).getByRole("link", { name: /Tasks/ })).toHaveTextContent("Board and TaskNotes");
    expect(within(summary).getByRole("link", { name: /Tasks/ })).toHaveAttribute("href", "/?collection=tasks");
  });

  it("starts an empty account with the official apps and a first collection", () => {
    const navigate = renderHome({ rows: [] });

    expect(screen.queryByRole("region", { name: "Your apps" })).not.toBeInTheDocument();
    const start = screen.getByRole("region", { name: "Start with an app" });
    expect(within(start).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Open Editor", "Open Reader", "Open Writer", "Open Journal", "Open TaskNotes"]);
    expect(screen.getByText("Add your first collection")).toBeInTheDocument();
    within(screen.getByRole("region", { name: "Collections" })).getByRole("link", { name: "Add collection" }).click();
    expect(navigate).toHaveBeenCalledWith("collections", undefined);
  });

  it("suggests nothing on a custom server", () => {
    renderHome({ origins: null, grants: [grant("board", "Board", "https://board.example/", notes)] });

    expect(within(screen.getByRole("region", { name: "Your apps" })).getByRole("link", { name: "Open Board" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "More apps from mdbase" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Start with an app" })).not.toBeInTheDocument();
  });

  it("says where apps appear when a custom server's account has none", () => {
    renderHome({ origins: null });

    expect(within(screen.getByRole("region", { name: "Your apps" })).getByText("Apps you approve appear here.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Collections" })).getByRole("link", { name: /Garden notes/ })).toHaveTextContent("No apps yet");
  });

  it("does not offer to open an app without a usable web address", () => {
    renderHome({ origins: null, grants: [grant("plain", "Plain", "http://plain.example/", notes)] });

    const yours = screen.getByRole("region", { name: "Your apps" });
    expect(within(yours).getByText("Plain")).toBeInTheDocument();
    expect(within(yours).queryByRole("link")).not.toBeInTheDocument();
  });
});
