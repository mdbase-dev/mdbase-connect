import { fireEvent, render, screen, within } from "./test/render";
import { ConnectManagementClient, type ManagementOverview } from "@mdbase/connect-management";
import { describe, expect, it, vi } from "vitest";
import { AppAccess, applicationGroups } from "./ApplicationAccess";

type Installation = NonNullable<ManagementOverview["installation_access"]>[number];
const installation = (overrides: Partial<Installation> = {}): Installation => ({
  application_id: "app-a", application_family_id: "family", application_name: "Reader", application_origin: "https://reader.example", icon: null,
  connector_id: "connector-a", installation_id: "installation-11111111", device_kind: "app-runtime", created_at: "2026-01-01T12:00:00Z",
  create_collections: false, collection_id: "collection-a", collection_name: "Garden notes", sync: "cloud_copy", available: true, role: "owner", approved_optional_file_actions: [], ...overrides
});
function show(entries: Installation[], collectionName?: string) {
  const client = new ConnectManagementClient("https://connect.example");
  const remove = vi.spyOn(client, "removeInstallationAccess").mockResolvedValue({ok:true,state:"revoking",collection_id:"collection-a"});
  const revoke = vi.spyOn(client, "revokeInstallation").mockResolvedValue(undefined);
  const groups = applicationGroups([], entries);
  render(<AppAccess groups={groups} client={client} busy={new Set()} collectionName={collectionName} perform={async (_id, action) => { await action({}); return true; }} />);
  return { groups, remove, revoke };
}

describe("native installation display scopes", () => {
  it("groups only exact collection identities and keeps each genuine installation in details", () => {
    const { groups } = show([installation(), installation({application_id:"app-b",connector_id:"connector-b",installation_id:"installation-22222222",device_kind:"mobile",created_at:"2026-01-02T12:00:00Z"})]);
    expect(groups[0]!.installations).toHaveLength(2);
    expect(screen.getAllByText("Garden notes")).toHaveLength(1);
    expect(screen.getByText("2 installations")).toBeInTheDocument();
    expect(screen.getAllByRole("button", {name:"Revoke collection access"})).toHaveLength(1);
    expect(screen.getByText(/Mobile app/)).toBeInTheDocument();
    expect(screen.getByText(/App installation/)).toBeInTheDocument();
    expect(document.querySelectorAll("time[datetime]")).toHaveLength(2);
    expect(screen.getByText(/11111111/)).toBeInTheDocument();
    expect(screen.getByText(/22222222/)).toBeInTheDocument();
  });
  it("does not merge two collections sharing a stored display name", () => {
    show([installation(),installation({collection_id:"collection-b",connector_id:"connector-b",installation_id:"installation-22222222"})]);
    expect(screen.getAllByText("Garden notes")).toHaveLength(2);
    expect(screen.getAllByRole("button", {name:"Revoke collection access"})).toHaveLength(2);
    expect(document.querySelector(".connect-application > summary")).toHaveTextContent("2 collections");
  });
  it("revokes every persisted application ID in a grouped collection scope", async () => {
    const { remove } = show([installation(),installation({application_id:"app-b",connector_id:"connector-b",installation_id:"installation-22222222"}),installation({connector_id:"connector-c",installation_id:"installation-33333333"})]);
    const buttons = screen.getAllByRole("button", {name:"Revoke collection access"});
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name:"Revoke collection access"}));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledWith("app-a","collection-a",{});
    expect(remove).toHaveBeenCalledWith("app-b","collection-a",{});
  });
  it("also retains every application ID when revoking from the collection page", async () => {
    const { remove, revoke } = show([installation(),installation({application_id:"app-b",connector_id:"connector-b",installation_id:"installation-22222222"})], "Garden notes");
    fireEvent.click(screen.getByRole("button", {name:"Revoke access"}));
    fireEvent.click(screen.getByRole("button", {name:"Revoke access"}));
    await vi.waitFor(()=>expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledWith("app-a","collection-a",{});expect(remove).toHaveBeenCalledWith("app-b","collection-a",{});
    expect(revoke).not.toHaveBeenCalled();
  });
  it("keeps creation-only and mobile registration details without inventing collection scopes", async () => {
    const { revoke } = show([installation({collection_id:null,collection_name:null,role:null,sync:null,create_collections:true}),installation({collection_id:null,collection_name:null,role:null,sync:null,create_collections:false,device_kind:"mobile",connector_id:"connector-b",installation_id:"installation-22222222"})]);
    expect(screen.getAllByText("No collection access")).toHaveLength(1);
    expect(screen.getByText("2 installations")).toBeInTheDocument();
    expect(screen.getByText("Can create collections for your account")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name:"Revoke collection access"})).not.toBeInTheDocument();
    const details=screen.getByText("Installation details").closest("details")!;
    expect(within(details).getByText(/Mobile app/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"Revoke application"}));fireEvent.click(screen.getByRole("button", {name:"Revoke application"}));
    await vi.waitFor(()=>expect(revoke).toHaveBeenCalledTimes(2));
    expect(revoke).toHaveBeenCalledWith("connector-a",{});expect(revoke).toHaveBeenCalledWith("connector-b",{});
  });
});
