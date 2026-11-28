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
async function show(entries: Installation[], collectionName?: string) {
  const client = new ConnectManagementClient("https://connect.example");
  const remove = vi.spyOn(client, "removeInstallationAccess").mockResolvedValue({ok:true,state:"revoking",collection_id:"collection-a"});
  const revoke = vi.spyOn(client, "revokeInstallation").mockResolvedValue(undefined);
  const groups = applicationGroups([], entries);
  render(<AppAccess groups={groups} client={client} busy={new Set()} collectionName={collectionName} perform={async (_id, action) => { await action({}); return true; }} />);
  fireEvent.click(screen.getByText("Reader"));
  await screen.findAllByText("Installation details");
  return { groups, remove, revoke };
}

describe("native installation display scopes", () => {
  it("groups only exact collection identities and keeps each genuine installation in details", async () => {
    const { groups } = await show([installation(), installation({application_id:"app-b",connector_id:"connector-b",installation_id:"installation-22222222",device_kind:"mobile",created_at:"2026-01-02T12:00:00Z"})]);
    expect(groups[0]!.installations).toHaveLength(2);
    expect(screen.getAllByText("Garden notes")).toHaveLength(1);
    expect(screen.getByText("2 installations")).toBeInTheDocument();
    expect(screen.getAllByRole("button", {name:"Revoke collection access"})).toHaveLength(1);
    expect(screen.getByText(/Mobile app/)).toBeInTheDocument();
    expect(screen.getByText(/App installation/)).toBeInTheDocument();
    expect(document.querySelectorAll("time[datetime]")).toHaveLength(2);
    expect(screen.getByText("Installation reference nector-a")).toBeInTheDocument();
    expect(screen.getByText("Installation reference nector-b")).toBeInTheDocument();
  });
  it("keeps an unavailable scope available to review without counting its collection", async () => {
    await show([installation({ available: false, role: null })]);
    expect(document.querySelector(".connect-application > summary")).toHaveTextContent("0 collections");
    expect(screen.getByText(/Collection no longer visible to your account/)).toBeInTheDocument();
  });
  it("does not merge two collections sharing a stored display name", async () => {
    await show([installation(),installation({collection_id:"collection-b",connector_id:"connector-b",installation_id:"installation-22222222"})]);
    expect(screen.getAllByText("Garden notes")).toHaveLength(2);
    expect(screen.getAllByRole("button", {name:"Revoke collection access"})).toHaveLength(2);
    expect(document.querySelector(".connect-application > summary")).toHaveTextContent("2 collections");
  });
  it("revokes every persisted application ID in a grouped collection scope", async () => {
    const { remove } = await show([installation(),installation({application_id:"app-b",connector_id:"connector-b",installation_id:"installation-22222222"}),installation({connector_id:"connector-c",installation_id:"installation-33333333"})]);
    const buttons = screen.getAllByRole("button", {name:"Revoke collection access"});
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {name:"Revoke collection access"}));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledWith("app-a","collection-a",{});
    expect(remove).toHaveBeenCalledWith("app-b","collection-a",{});
  });
  it("also retains every application ID when revoking from the collection page", async () => {
    const { remove, revoke } = await show([installation(),installation({application_id:"app-b",connector_id:"connector-b",installation_id:"installation-22222222"})], "Garden notes");
    expect(screen.queryByRole("button", {name:"Revoke collection access"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name:"Remove installation"})).not.toBeInTheDocument();
    expect(screen.queryByText("1 collection")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"Revoke access"}));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke access" }));
    await vi.waitFor(()=>expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledWith("app-a","collection-a",{});expect(remove).toHaveBeenCalledWith("app-b","collection-a",{});
    expect(revoke).not.toHaveBeenCalled();
  });
  it("says an installation with Private device access may have had the account's encryption key, and what revoking cannot undo", async () => {
    const key = /it has had your account's encryption key, and revoking access doesn't take that key back\. If you no longer trust this app with your encryption password, change your encryption password\./;
    await show([installation({sync:"private",private_device:true}),installation({connector_id:"connector-b",installation_id:"installation-22222222",private_device:false})]);
    expect(screen.getAllByText(/Keeps this Private collection on its device\. If you unlocked it in this app, the app has had your account's encryption key/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", {name:"Revoke collection access"}));
    expect(within(screen.getByRole("dialog")).getByText(key)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {name:"Cancel"}));
    fireEvent.click(screen.getByRole("button", {name:"Revoke app"}));
    expect(within(screen.getByRole("dialog")).getByText(key)).toBeInTheDocument();
  });
  it("adds nothing about the key for cloud copies, or from a server that does not report device access", async () => {
    await show([installation(),installation({connector_id:"connector-b",installation_id:"installation-22222222",private_device:false})], "Garden notes");
    expect(screen.queryByText(/encryption key/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"Revoke access"}));
    expect(within(screen.getByRole("dialog")).queryByText(/encryption key/)).not.toBeInTheDocument();
  });
  it("removes only the selected installation after it loses its last collection", async () => {
    const { remove, revoke } = await show([installation(), installation({connector_id:"connector-b", installation_id:"installation-22222222", collection_id:null, collection_name:null, role:null, sync:null})]);
    const row = screen.getByText("This installation has no approved collections.").parentElement!;
    fireEvent.click(within(row).getByRole("button", {name:"Remove installation"}));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", {name:"Remove installation nector-b of Reader?"})).getByRole("button", {name:"Remove installation"}));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith("connector-b", {}));
    expect(remove).not.toHaveBeenCalled();
  });
  it("keeps creation-only and mobile registration details without inventing collection scopes", async () => {
    const { revoke } = await show([installation({collection_id:null,collection_name:null,role:null,sync:null,create_collections:true}),installation({collection_id:null,collection_name:null,role:null,sync:null,create_collections:false,device_kind:"mobile",connector_id:"connector-b",installation_id:"installation-22222222"})]);
    expect(screen.getAllByText("No collection access")).toHaveLength(1);
    expect(screen.getByText("2 installations")).toBeInTheDocument();
    expect(screen.getByText("Can create collections for your account")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name:"Revoke collection access"})).not.toBeInTheDocument();
    const details=screen.getByText("Installation details").closest("details")!;
    expect(within(details).getByText(/Mobile app/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"Revoke app"}));fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke app" }));
    await vi.waitFor(()=>expect(revoke).toHaveBeenCalledTimes(2));
    expect(revoke).toHaveBeenCalledWith("connector-a",{});expect(revoke).toHaveBeenCalledWith("connector-b",{});
  });
});
