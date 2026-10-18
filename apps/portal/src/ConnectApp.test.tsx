import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { ConnectManagementClient, type AccountData, type ManagementOverview } from "@mdbase/connect-management";
import { AccountManagement } from "./AccountManagement";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectApp } from "./ConnectApp";
import { chooseOption } from "./test/select";

let overview: ManagementOverview;

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/?collection=collection");
  overview = overviewFixture();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/ui-configuration") return Response.json({ editor_url: "https://editor.example.test/connect" });
    if (path === "/v1/account/sessions") {
      return Response.json({ sessions: [] });
    }
    if (path === "/v1/account") {
      return Response.json(init?.method === "DELETE" ? { ok: true } : accountFixture());
    }
    return Response.json(overview);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConnectApp", () => {
  it.each([false, true])("offers one Add collection flow with a Native handoff when Hosted enabled=%s", async hosted => {
    history.replaceState(null, "", "/collections");
    overview.hosted_collections_available = hosted;
    Object.assign(overview, { native_collection_creation_available: true });
    const user = userEvent.setup();
    render(<ConnectApp />);
    const add = await screen.findByRole("button", { name: "Add collection" });
    expect(screen.queryByRole("button", { name: "New hosted collection" })).not.toBeInTheDocument();
    await user.click(add);
    const location = screen.getByRole("combobox", { name: "Location" });
    if (hosted) await chooseOption(user, location, "On this computer");
    expect(screen.getByRole("link", { name: "Open mdbase connect" })).toHaveAttribute("href", "mdbase-connect://open");
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("keeps Add collection visible without inventing a Native device or Hosted authority", async () => {
    history.replaceState(null, "", "/collections");
    overview.hosted_collections_available = false;
    Object.assign(overview, { native_collection_creation_available: false });
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("button", { name: "Add collection" }));
    expect(screen.getByText("Connect a computer to add a collection.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Location" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
  });

  it("maps Private badges to their exact enrolled computer's presence, never another online computer", async () => {
    history.replaceState(null, "", "/collections");
    overview.collections = []; overview.hosted_collections = [];
    overview.connectors.push({ id: "sleeping", name: "Sleeping laptop", created_at: new Date().toISOString(), last_seen_at: new Date(Date.now() - 120_000).toISOString() });
    const access = { relationship: "owner", role: "owner", can_manage_members: true } as const;
    Object.assign(overview, { native_collections: [
      { id: "native-private", display_name: "Computer notes", sync: "private", computer_ids: ["computer"], access },
      { id: "native-offline", display_name: "Offline notes", sync: "private", computer_ids: ["sleeping"], access },
      { id: "native-none", display_name: "Unlinked notes", sync: "private", computer_ids: [], access },
      { id: "native-cloud", display_name: "Cloud notes", sync: "cloud_copy", computer_ids: [], access },
    ] });
    render(<ConnectApp />);
    await screen.findByText("Computer notes");
    const badge = (name: string) => screen.getByText(name).closest(".connect-row")?.querySelector(".connect-status");
    expect(badge("Computer notes")).toHaveTextContent("On Home computer");
    expect(badge("Offline notes")).toHaveTextContent("On Sleeping laptop: offline");
    expect(badge("Unlinked notes")).toHaveTextContent("Computer not connected");
    expect(badge("Cloud notes")).toHaveTextContent("Hosted");
    expect(screen.queryByText("Availability unknown")).not.toBeInTheDocument();
  });

  it("counts native collections without legacy shadow rows or content authorization", async () => {
    overview.collections = [];
    overview.hosted_collections = [];
    overview.grants = [];
    overview.native_collections = [
      { id: "native", display_name: "Native notes", sync: "cloud_copy", access: { relationship: "owner", role: "owner", can_manage_members: false } },
      { id: "private", display_name: "Private notes", sync: "private", access: { relationship: "member", role: "viewer", can_manage_members: false } }
    ];
    history.replaceState(null, "", "/collections?server=https%3A%2F%2Funtrusted.example");
    const { container } = render(<ConnectApp />);
    expect(await screen.findByRole("heading", { name: "Collections" })).toBeInTheDocument();
    expect(screen.getByText("Native notes")).toBeInTheDocument();
    expect(screen.getByText("Private notes")).toBeInTheDocument();
    expect(container.querySelector(".connect-section-title")).toHaveTextContent("All collections2");
    expect(vi.mocked(fetch).mock.calls.every(([input, init]) => new URL(String(input)).origin === location.origin && (!init?.method || init.method === "GET"))).toBe(true);
  });

  it("reviews and revokes genuine installation scope without manufacturing a grant", async () => {
    overview.grants = [];
    overview.installation_access = [installationFixture()];
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: "Applications" }));
    expect(await screen.findByText("Reader app")).toBeInTheDocument();
    expect(screen.getByText("Entire collection · Access as your account (owner)")).toBeInTheDocument();
    expect(screen.queryByText(/permissions ·/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke collection access" }));
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Revoke collection access" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => new URL(String(input)).pathname === "/v1/account/applications/registered-app/remove-installation-access" && init?.body === JSON.stringify({ collection_id: "collection", confirm: true }))).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname.startsWith("/v1/grants"))).toBe(false);
  });

  it("can revoke a creation-only app registration through canonical installation sign-out", async () => {
    overview.grants = [];
    overview.installation_access = [{ ...installationFixture(), collection_id: null, collection_name: null, sync: null, role: null, create_collections: true }];
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: "Applications" }));
    expect(await screen.findByText("No collection access")).toBeInTheDocument();
    expect(screen.getByText("Can create collections for your account")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => new URL(String(input)).pathname === "/v1/account/installations/installation-connector" && init?.method === "DELETE")).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname.startsWith("/v1/grants"))).toBe(false);
  });

  it("opens Reader's existing manage-access route on Applications", async () => {
    history.replaceState(null, "", "/account/applications");
    render(<ConnectApp />);
    expect(await screen.findByRole("heading", { name: "Applications" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Browser sessions" })).not.toBeInTheDocument();
  });

  it("opens /account directly on Connect and retains browser-session controls", async () => {
    history.replaceState(null, "", "/account");
    render(<ConnectApp />);
    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Browser sessions" })).toBeInTheDocument();
    expect(location.pathname).toBe("/account");
    expect(screen.queryByRole("complementary", { name: "Collection navigation" })).not.toBeInTheDocument();
  });

  it("orbits the mark while Connect is opening", () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = render(<ConnectApp />);

    expect(screen.getByText("Opening mdbase connect")).toBeInTheDocument();
    expect(container.querySelector(".connect-loading .mdbase-mark")).toBeInTheDocument();
    expect(container.querySelector(".connect-loading .mdbase-motion-orbit")).toBeInTheDocument();
  });

  it("clears password inputs after success even when the following overview refresh fails", async () => {
    const user = userEvent.setup();
    const onOverviewRefresh = vi.fn().mockRejectedValue(new Error("Overview offline"));
    render(<AccountManagement client={new ConnectManagementClient("http://127.0.0.1:8787")} overview={overview} onOverviewRefresh={onOverviewRefresh} onDeleted={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText("Current password"), "old password");
    await user.type(screen.getByLabelText("New password"), "a sufficiently long password");
    await user.type(screen.getByLabelText("Confirm new password"), "a sufficiently long password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Password changed. Other browser sessions were signed out.")).toBeInTheDocument();
    expect(await screen.findByText(/Your change was saved, but account details could not refresh/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
  });

  it("filters registered computers without revoking them and distinguishes duplicate names", async () => {
    const now = new Date().toISOString();
    overview.connectors = [
      { ...overview.connectors[0], name: "Desk" },
      { id: "offline-11111111", name: "Desk", created_at: "2026-01-01T12:00:00Z", last_seen_at: new Date(Date.now() - 120_000).toISOString() },
      { id: "pending-22222222", name: "Never connected", created_at: now, last_seen_at: null },
      { id: "upgrade-33333333", name: "Old computer", created_at: now, last_seen_at: now, compatibility: "upgrade_required" }
    ];
    const user = userEvent.setup();
    const { container } = render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: "Computers" }));
    const rows = () => [...container.querySelectorAll(".connect-main .connect-row")];
    expect(screen.getByRole("heading", { name: "Registered computers" })).toBeInTheDocument();
    expect(rows()).toHaveLength(4);
    expect(screen.getByText(/ID 11111111/)).toBeInTheDocument();
    expect(screen.getByText(/ID computer/)).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Find a computer" });
    await user.type(search, "dEsK");
    expect(rows()).toHaveLength(2);
    await user.clear(search);
    await user.type(search, "11111111");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("ID 11111111");
    await chooseOption(user, screen.getByRole("combobox", { name: "Computer status" }), "Online");
    expect(screen.getByText("No computers match")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Computer filter results" })).toHaveTextContent("Showing 0 of 4 registered computers.");
    await user.clear(search);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("ID computer");
    await chooseOption(user, screen.getByRole("combobox", { name: "Computer status" }), "Offline");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("ID 11111111");
    await chooseOption(user, screen.getByRole("combobox", { name: "Computer status" }), "Not connected yet");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("ID 22222222");
    await chooseOption(user, screen.getByRole("combobox", { name: "Computer status" }), "Update required");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("ID 33333333");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("labels duplicate browser sessions and signs out only the explicitly chosen session", async () => {
    const sessions = ["current-11111111", "other-22222222"].map((id, index) => ({
      id, client_name: "Chrome on Linux", provider: "password", created_at: `2026-01-0${index + 1}T12:00:00Z`,
      last_seen_at: new Date().toISOString(), expires_at: "2027-01-01T12:00:00Z", current: index === 0
    }));
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account/sessions") return Response.json({ sessions });
      if (path === "/v1/account") return Response.json(accountFixture());
      if (init?.method === "DELETE") return Response.json({ ok: true });
      return Response.json(overview);
    });
    const user = userEvent.setup();
    const { container } = render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: "Open account and sessions" }));
    expect(await screen.findByText(/ID 22222222/)).toBeInTheDocument();
    expect(screen.getByText(/ID 11111111/)).toBeInTheDocument();
    expect([...container.querySelectorAll("time")].map(time => time.dateTime)).toEqual(sessions.map(session => session.created_at));
    expect(screen.getAllByRole("button", { name: /^Sign out$/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^Sign out$/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE").map(([input]) => new URL(String(input)).pathname)).toEqual(["/v1/account/sessions/other-22222222"]));
  });

  it("puts current-browser sign-out above sessions and signs out only this browser once", async () => {
    const client = new ConnectManagementClient("http://127.0.0.1:8787");
    let complete!: () => void;
    const logout = vi.spyOn(client, "logout").mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const revoke = vi.spyOn(client, "revokeSession");
    const others = vi.spyOn(client, "revokeOtherSessions");
    const refresh = vi.fn();
    const destination = { href: "http://127.0.0.1:8787/account", search: "", hash: "" };
    vi.stubGlobal("location", destination);
    const { container } = render(<AccountManagement client={client} overview={overview}
      sessions={[{id:"current",client_name:"This test browser",provider:"password",
        created_at:"2026-01-01T12:00:00Z",last_seen_at:"2026-01-01T12:00:00Z",
        expires_at:"2027-01-01T12:00:00Z",current:true}]}
      onOverviewRefresh={refresh} onDeleted={vi.fn()} />);
    const signOut = await screen.findByRole("button", { name: "Sign out of this browser" });
    expect(signOut.compareDocumentPosition(container.querySelector(".connect-row")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(signOut);
    fireEvent.click(signOut);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    await act(async () => complete());
    expect(destination.href).toBe("http://127.0.0.1:8787/login?return_to=%2Faccount");
    expect(revoke).not.toHaveBeenCalled();
    expect(others).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps sign-out available without session results and makes failure retryable", async () => {
    const client = new ConnectManagementClient("http://127.0.0.1:8787");
    const logout = vi.spyOn(client, "logout").mockRejectedValue(new Error("Sign-out failed. Try again."));
    render(<AccountManagement client={client} overview={overview} onOverviewRefresh={vi.fn()} onDeleted={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out of this browser" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-out failed. Try again.");
    expect(screen.getByRole("button", { name: "Sign out of this browser" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Sign out of this browser" }));
    expect(logout).toHaveBeenCalledTimes(2);
  });

  it("opens account management without requesting a collection grant", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(calls).toEqual(expect.arrayContaining(["/v1/me", "/v1/account/sessions"]));
    expect(calls.some((path) => path.includes("authorization"))).toBe(false);

    await user.click(screen.getByRole("link", { name: /Applications/ }));
    await waitFor(() => expect(location.pathname).toBe("/applications"));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeInTheDocument();
  });

  it("opens feedback from the quiet Connect footer with current context available", async () => {
    overview.grants = applicationGrants();
    const user = userEvent.setup();
    render(<ConnectApp />);

    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getAllByRole("button", { name: "Send feedback" })[0]);

    expect(location.pathname).toBe("/");
    expect(screen.getByRole("dialog", { name: "Send feedback" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /What happened/ })).toHaveFocus();
    await user.click(screen.getByText("What gets sent"));
    expect(screen.getByRole("checkbox", { name: /Include collection name: Garden notes/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Include technical diagnostics/ })).not.toBeChecked();
    expect(screen.getByText("Private feedback to the mdbase team.")).toBeInTheDocument();
  });

  it("manages collections on the portal without mounting the Editor shell", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);
    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    const navigation = screen.getByRole("complementary", { name: "mdbase connect navigation" });
    expect(navigation).toHaveTextContent("All collections");
    expect(navigation).toHaveTextContent("Account & sessions");
    expect(screen.queryByRole("complementary", { name: "Collection navigation" })).not.toBeInTheDocument();
    const editor = new URL((await screen.findByRole("link", { name: "Open editor" })).getAttribute("href")!);
    expect(editor.origin).toBe("https://editor.example.test");
    expect(editor.pathname).toBe("/");
    expect(editor.searchParams.get("collection")).toBe("collection");
    expect(editor.searchParams.get("server")).toBe(location.origin);
    await user.click(screen.getByRole("link", { name: "Storage & sync" }));
    await waitFor(() => expect(location.pathname).toBe("/storage"));
    expect(screen.getByRole("heading", { name: "Storage & sync" })).toHaveFocus();
    expect(document.title).toBe("Storage & sync - mdbase connect");
  });

  it("does not fall back to a production Editor when none is configured", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => new URL(String(input)).pathname === "/v1/ui-configuration" ? Promise.resolve(Response.json({ editor_url: null })) : original(input, init));
    render(<ConnectApp />);
    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname === "/v1/account/sessions")).toBe(true));
    expect(screen.queryByRole("link", { name: "Open editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Choose or create my person record" })).not.toBeInTheDocument();
  });

  it("opens the only collection directly and records its context in the URL", async () => {
    history.replaceState(null, "", "/");
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(location.search).get("collection")).toBe("collection"));
  });

  it("opens all collections when a direct entry has no unambiguous collection", async () => {
    overview.collections.push(secondCollection());
    history.replaceState(null, "", "/");
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Collections" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All collections" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(location.pathname).toBe("/collections"));
    expect(new URLSearchParams(location.search).has("collection")).toBe(false);
  });

  it("restores the last selected collection on direct entry", async () => {
    overview.collections.push(secondCollection());
    localStorage.setItem(`mdbase-connect:last-collection:${location.origin}`, "collection-two");
    history.replaceState(null, "", "/");
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

  it("distinguishes an incompatible computer from an ordinary offline one", async () => {
    overview.connectors[0].compatibility = "upgrade_required";
    overview.connectors[0].connector_version = "0.1.0-beta.30";
    overview.connectors[0].minimum_connector_version = "0.1.0-beta.33";
    overview.connectors[0].update_url = "https://example.test/connect-update";
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    expect(screen.getAllByText("Update required").length).toBeGreaterThan(0);
    expect(screen.getByText("Update mdbase connect on Home computer before using this collection."))
      .toBeInTheDocument();
    expect(screen.queryByText("The editor can reach this collection now.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Computers" }));
    expect(await screen.findByRole("link", { name: "Install version 0.1.0-beta.33 or later" }))
      .toHaveAttribute("href", "https://example.test/connect-update");
  });

  it("recommends the lease-capable update without claiming legacy is incompatible", async () => {
    overview.connectors[0].update_recommended = true;
    overview.connectors[0].minimum_connector_version = "0.1.0-beta.91";
    overview.connectors[0].update_url = "https://example.test/connect-update";
    const user = userEvent.setup();
    render(<ConnectApp />);

    await user.click(await screen.findByRole("link", { name: "Computers" }));
    expect(screen.getByText("Online", { selector: ".connect-status" })).toBeInTheDocument();
    expect(screen.queryByText("Update required", { selector: ".connect-status" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", {
      name: "Update recommended for current policy protection"
    })).toHaveAttribute("href", "https://example.test/connect-update");
  });

  it("displays a slow successful overview instead of starving it with background generations", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => new URL(String(input)).pathname === "/v1/me"
      ? new Promise<Response>(resolve => setTimeout(() => resolve(Response.json(overview)), 20_000))
      : originalFetch(input, init));
    render(<ConnectApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname === "/v1/me")).toHaveLength(1);
  });

  it("offers a read-only retry when the initial overview is unavailable", async () => {
    const read = vi.spyOn(ConnectManagementClient.prototype, "overview")
      .mockRejectedValueOnce(new Error("The management request timed out."))
      .mockResolvedValue(overview);
    render(<ConnectApp />);
    await screen.findByText("mdbase connect is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("starts a fresh read after a mutation rather than reusing its pre-mutation snapshot", async () => {
    const updated = structuredClone(overview);
    updated.hosted_collections.push({ ...hostedCollection(), id: "created", display_name: "Created while loading" });
    let finishOld!: (value: ManagementOverview) => void;
    const read = vi.spyOn(ConnectManagementClient.prototype, "overview")
      .mockResolvedValueOnce(overview)
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValue(updated);
    const user = userEvent.setup();
    render(<ConnectApp />);
    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("link", { name: "All collections" }));
    await user.click(screen.getByRole("button", { name: "Add collection" }));
    await chooseOption(user, screen.getByRole("combobox", { name: "Location" }), "Hosted");
    fireEvent(document, new Event("visibilitychange"));
    expect(read).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await act(async () => finishOld(overview));
    expect(await screen.findByText("Created while loading")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not reuse an aborted initial read when effects restart", async () => {
    render(<StrictMode><ConnectApp /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname === "/v1/me")).toHaveLength(2);
  });

  it("pauses background refresh while the page is hidden and refreshes on return", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.useFakeTimers();
    render(<ConnectApp />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const overviewCalls = () => vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname === "/v1/me").length;
    expect(overviewCalls()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(overviewCalls()).toBe(1);

    visibility.mockReturnValue("visible");
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(overviewCalls()).toBe(2);
  });

  it("coalesces visibility refreshes until the pending overview settles", async () => {
    const older = structuredClone(overview);
    let resolveOlder: ((response: Response) => void) | undefined;
    let overviewCall = 0;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account/sessions") return Response.json({ sessions: [] });
      if (path !== "/v1/me") return Response.json({ ok: true });
      overviewCall += 1;
      if (overviewCall === 1) {
        return new Promise<Response>((resolve) => { resolveOlder = resolve; });
      }
      const newer = structuredClone(overview);
      newer.collections[0].display_name = "Newest collection";
      return Response.json(newer);
    });
    render(<ConnectApp />);
    await waitFor(() => expect(overviewCall).toBe(1));

    fireEvent(document, new Event("visibilitychange"));
    expect(overviewCall).toBe(1);
    await act(async () => resolveOlder?.(Response.json(older)));
    expect(await screen.findByRole("heading", { name: "Garden notes" })).toBeInTheDocument();

    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("heading", { name: "Newest collection" })).toBeInTheDocument();
    expect(overviewCall).toBe(2);
    expect(screen.queryByRole("heading", { name: "Garden notes" })).not.toBeInTheDocument();
  });

  it("keeps collection input open after a failed creation", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);
    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("link", { name: "All collections" }));
    await user.click(await screen.findByRole("button", { name: "Add collection" }));

    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account/collections" && init?.method === "POST") {
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
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry creation" })).toBeInTheDocument();
    const first = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url,init]) => new URL(String(url)).pathname === "/v1/account/collections" && init?.method === "POST")![1]!.body));
    await user.click(screen.getByRole("button", {name:"Retry creation"}));
    await waitFor(()=>expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>new URL(String(url)).pathname==="/v1/account/collections"&&init?.method==="POST")).toHaveLength(2));
    const second = JSON.parse(String(vi.mocked(fetch).mock.calls.filter(([url,init])=>new URL(String(url)).pathname==="/v1/account/collections"&&init?.method==="POST")[1][1]!.body));
    expect(second).toEqual(first);
    expect(Object.keys(second).sort()).toEqual(["account_id","display_name","request_id","timezone"]);
    expect(screen.getByRole("combobox", { name: "Location" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Open mdbase connect" })).not.toBeInTheDocument();
  });

  it("restores an uncertain original creation after reload and has one Add action even without hosted availability",async()=>{
    overview.hosted_collections_available=false;
    const account=overview.user.id;
    localStorage.setItem(`mdbase.connect.collection-creation:${account}`,JSON.stringify({accountId:account,requestId:"11111111-1111-4111-a111-111111111111",displayName:"Uncertain name",timezone:"UTC"}));
    const user=userEvent.setup();render(<ConnectApp/>);
    await user.click(await screen.findByRole("link",{name:"All collections"}));
    await user.click(await screen.findByRole("button",{name:"Add collection"}));
    expect(screen.getByLabelText("Collection name")).toHaveValue("Uncertain name");
    expect(screen.getByLabelText("Collection name")).toBeDisabled();
    expect(screen.getByRole("button",{name:"Retry creation"})).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Location" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Open mdbase connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
  });

  it("renames inline and confirms destructive collection actions in the page", async () => {
    overview.hosted_collections = [hostedCollection()];
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: "All collections" }));

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const rename = screen.getByLabelText("Rename Hosted research");
    await user.clear(rename);
    await user.type(rename, "Shared research");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Rename Hosted research")).not.toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH" && init.body === JSON.stringify({ display_name: "Shared research" }))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("group", { name: /Delete Hosted research and all of its hosted data/ })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
  });

  it("invites and manages collection members from the collection overview", async () => {
    overview.collections = [];
    overview.hosted_collections = [hostedCollection()];
    history.replaceState(null, "", "/?collection=hosted");
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/members") && (!init?.method || init.method === "GET")) {
        return Response.json({ members: [
          { kind: "owner", name: "Example Person", role: "owner", state: "active", accepted_at: new Date().toISOString() },
          { kind: "member", id: "member", name: "Shared Person", role: "viewer", state: "active", accepted_at: new Date().toISOString(), revoked_at: null }
        ] });
      }
      if (path.endsWith("/invitations") && init?.method === "POST") {
        return Response.json({ invitation: {
          id: "invitation",
          collection_id: "hosted",
          target_mode: "email",
          submitted_email: "new@example.com",
          role: "editor",
          state: "pending",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          created_at: new Date().toISOString(),
          token: "cinv_private-token"
        } }, { status: 202 });
      }
      if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) {
        return Response.json({ invitations: [] });
      }
      return originalFetch(input, init);
    });
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "People & sharing" })).toBeInTheDocument();
    expect(await screen.findByText("Shared Person")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invite person" }));
    await user.type(screen.getByLabelText("Email address"), "new@example.com");
    await chooseOption(user, screen.getByRole("combobox", { name: "Role" }), "editor");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));

    const link = await screen.findByLabelText("Collection invitation link");
    expect((link as HTMLInputElement).value).toContain(
      "#collection-invitation=cinv_private-token"
    );
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      new URL(String(input)).pathname.endsWith("/invitations")
      && init?.method === "POST"
      && init.body === JSON.stringify({ email: "new@example.com", role: "editor" })
    )).toBe(true);

    await chooseOption(user, screen.getByRole("combobox", { name: "Role for Shared Person" }), "editor");
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      new URL(String(input)).pathname.endsWith("/members/member")
      && init?.method === "PATCH"
      && init.body === JSON.stringify({ role: "editor" })
    )).toBe(true);
  });

  it("hides owner-only and sharing controls from viewers", async () => {
    const hosted = hostedCollection();
    hosted.access = {
      relationship: "member",
      role: "viewer",
      can_authorize_applications: true,
      can_manage_collection: false,
      can_rename_collection: false,
      can_delete_collection: false,
      can_manage_members: false
    };
    overview.collections = [];
    overview.hosted_collections = [hosted];
    history.replaceState(null, "", "/collections?collection=hosted");
    render(<ConnectApp />);

    expect(await screen.findByRole("heading", { name: "Collections" })).toBeInTheDocument();
    expect(screen.getAllByText("Hosted research").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "People & sharing" })).not.toBeInTheDocument();
  });

  it("accepts a fragment-bound collection invitation without retaining the token", async () => {
    history.replaceState(null, "", "/?collection=collection#delete_token=keep&collection-invitation=cinv_private-token");
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/hosted/collection-invitations/accept") {
        const shared = hostedCollection();
        shared.id = "shared";
        shared.display_name = "Shared collection";
        overview.hosted_collections = [shared];
        return Response.json({ membership: {
          id: "membership",
          collection_id: "shared",
          role: "viewer",
          state: "active"
        } }, { status: 201 });
      }
      return originalFetch(input, init);
    });
    const user = userEvent.setup();
    render(<ConnectApp />);

    expect(await screen.findByText("A collection was shared with you")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(location.hash).toBe("#delete_token=keep"));
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      new URL(String(input)).pathname === "/v1/hosted/collection-invitations/accept"
      && init?.method === "POST"
      && init.body === JSON.stringify({ token: "cinv_private-token" })
    )).toBe(true);
  });

  it("offers recovery actions when no computer is connected", async () => {
    overview.connectors = [];
    overview.collections = [];
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: "Computers" }));

    expect(await screen.findByText("No computers connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open mdbase connect" })).toHaveAttribute("href", "mdbase-connect://open");
    expect(screen.getByRole("link", { name: "Install the latest release" })).toHaveAttribute("href", "https://mdbase.dev/downloads/");
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
      created_at: now, revoked_at: null, revocation_status: "active",
      reauthorization_required_at: null, reauthorization_reason: null,
      collection_id: "collection", collection_name: "Garden notes",
      collection_kind: "local", application_id: "reading-list", application_name: "Reading list",
      distribution: "web", homepage: "https://reading.example", project_url: null,
      application_origin: "https://reading.example", icon: null
    }];
    render(<ConnectApp />);

    expect(await screen.findByRole("link", { name: /Reading list is waiting.*Review request/ })).toBeInTheDocument();
    expect(screen.getAllByText("Reading list is waiting")).toHaveLength(1);
    expect(screen.getByText("Read and update records")).toBeInTheDocument();
    expect(screen.queryByText(/allowed actions/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "App access" })).not.toHaveTextContent("1");
  });

  it("shows real revoked migration evidence until fresh collection authorization replaces it", async () => {
    const now = new Date().toISOString();
    const legacy = {
      id: "legacy", operations: ["read"],
      scope: { contracts: [], access: "contract" as const },
      created_at: now, revoked_at: now, revocation_status: "revoked" as const,
      reauthorization_required_at: now, reauthorization_reason: "collection_level_authorization",
      collection_id: "collection", collection_name: "Garden notes",
      collection_kind: "local" as const, application_id: "reading-list", application_name: "Reading list",
      distribution: "web" as const, homepage: "https://reading.example", project_url: null,
      application_origin: "https://reading.example", icon: null
    };
    overview.grants = [legacy];
    const user = userEvent.setup();
    render(<ConnectApp />);

    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("link", { name: /Applications/ }));

    expect(await screen.findByText("Legacy scoped access is revoked. Reauthorize this application for the entire collection.")).toBeInTheDocument();
    expect(screen.getByText("Reauthorization required")).toBeInTheDocument();

    overview.grants = [legacy, {
      ...legacy,
      id: "fresh",
      scope: { contracts: [], access: "full_collection" },
      revoked_at: null,
      revocation_status: "active",
      reauthorization_required_at: null,
      reauthorization_reason: null
    }];
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(screen.queryByText("Reauthorization required")).not.toBeInTheDocument());
    expect(screen.getByText("Entire collection")).toBeInTheDocument();
  });

  it.each(["local", "hosted"] as const)("keeps %s pending revocations visible without claiming success", async (kind) => {
    overview.grants = [{
      id: "grant", operations: ["read"],
      scope: { contracts: [], access: "full_collection" },
      created_at: new Date().toISOString(), revoked_at: new Date().toISOString(),
      revocation_status: "revoking", reauthorization_required_at: null,
      reauthorization_reason: null, collection_id: "collection",
      collection_name: "Garden notes", collection_kind: kind,
      application_id: "app", application_name: "Photo catalog",
      distribution: "web", homepage: "https://photos.example",
      project_url: null, application_origin: "https://photos.example", icon: null
    }];
    const user = userEvent.setup();
    render(<ConnectApp />);

    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("link", { name: /Applications/ }));

    expect(await screen.findByText("Revoking…")).toBeInTheDocument();
    expect(screen.getByText(kind === "hosted"
      ? /Waiting for the hosted authority to confirm enforcement/
      : /Waiting for the computer holding this collection to confirm enforcement/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("distinguishes same-named grants by their actual origin and collection ID with plain permission labels", async () => {
    const operations = ["read_type", "assess_collection_setup", "apply_collection_setup", "list_timers"];
    overview.grants = applicationGrants().map((grant, index) => ({
      ...grant, operations, collection_name: "New collection", collection_id: index === 0 ? "collection" : "collection-two",
      homepage: "https://homepage.example", application_origin: index === 0 ? "https://lab.tasknotes-app.pages.dev" : "http://127.0.0.1:48220"
    }));
    const user = userEvent.setup();
    const { container } = render(<ConnectApp />);
    await screen.findByRole("heading", { name: "Garden notes" });
    await user.click(screen.getByRole("link", { name: /Applications/ }));
    const grants = [...container.querySelectorAll("details.connect-grant")];
    expect(grants).toHaveLength(2);
    expect(grants.map(grant => grant.querySelector("summary")?.textContent)).toEqual(expect.arrayContaining([
      "New collection4 permissions · lab.tasknotes-app.pages.devPermissions",
      "New collection4 permissions · Local development (127.0.0.1:48220)Permissions"
    ]));
    expect(grants.every(grant => grant.textContent?.includes("Collection ID"))).toBe(true);
    expect(grants.map(grant => grant.querySelector(".connect-grant-meta strong")?.textContent).sort()).toEqual(["collection", "collection-two"]);
    for (const grant of grants) {
      expect(grant.textContent).toContain("View record types");
      expect(grant.textContent).toContain("Check what this app needs to set up");
      expect(grant.textContent).toContain("Set up this app in the collection");
      expect(grant.textContent).toContain("See this app's scheduled activity");
      expect(grant.textContent).not.toContain("homepage.example");
    }
  });

  it("revokes every application grant through one batch and refreshes", async () => {
    const now = new Date().toISOString();
    overview.grants = ["grant-a", "grant-b"].map((id, index) => ({
      id,
      operations: ["read"],
      scope: { contracts: [], access: "full_collection" as const },
      created_at: now,
      revoked_at: null,
      revocation_status: "active" as const,
      reauthorization_required_at: null,
      reauthorization_reason: null,
      collection_id: index === 0 ? "collection" : "collection-two",
      collection_name: index === 0 ? "Garden notes" : "Research notes",
      collection_kind: "local" as const,
      application_id: "reading-list",
      application_name: "Reading list",
      distribution: "web" as const,
      homepage: "https://reading.example",
      project_url: null,
      application_origin: "https://reading.example",
      icon: null
    }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/v1/grants/revoke-batch") return originalFetch(input, init);
      overview.grants = [];
      return Response.json({
        ok: true,
        results: [
          { grant_id: "grant-a", status: "revoked" },
          { grant_id: "grant-b", status: "revoked" }
        ]
      });
    });
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: /Applications/ }));
    await user.click(screen.getByText("Reading list"));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));

    await waitFor(() => expect(screen.queryByText("Reading list")).not.toBeInTheDocument());
    const batchCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === "/v1/grants/revoke-batch"
    );
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0][1]?.body).toBe(JSON.stringify({ grant_ids: ["grant-a", "grant-b"] }));
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("suppresses rapid duplicate application revocation clicks", async () => {
    overview.grants = applicationGrants();
    let finishBatch: (() => void) | undefined;
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname !== "/v1/grants/revoke-batch") {
        return originalFetch(input, init);
      }
      await new Promise<void>((resolve) => { finishBatch = resolve; });
      overview.grants = [];
      return Response.json({
        ok: true,
        results: [
          { grant_id: "grant-a", status: "revoked" },
          { grant_id: "grant-b", status: "revoked" }
        ]
      });
    });
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: /Applications/ }));
    await user.click(screen.getByText("Reading list"));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    const confirm = screen.getByRole("button", { name: "Revoke application" });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === "/v1/grants/revoke-batch"
    )).toHaveLength(1);

    await act(async () => finishBatch?.());
    await waitFor(() => expect(screen.queryByText("Reading list")).not.toBeInTheDocument());
  });

  it("shows exact partial revocation and refreshes to the remaining truth", async () => {
    overview.grants = applicationGrants();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname !== "/v1/grants/revoke-batch") {
        return originalFetch(input, init);
      }
      overview.grants = overview.grants.filter(({ id }) => id === "grant-b");
      return Response.json({
        ok: false,
        results: [
          { grant_id: "grant-a", status: "revoked" },
          { grant_id: "grant-b", status: "conflict" }
        ]
      });
    });
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: /Applications/ }));
    await user.click(screen.getByText("Reading list"));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "1 grants were revoked; 1 changed concurrently. The current state has been refreshed."
    );
    expect(screen.getByText("Reading list")).toBeInTheDocument();
    expect(screen.getByText("Research notes")).toBeInTheDocument();
    expect(screen.queryByText("Garden notes", { selector: ".connect-application-body strong" }))
      .not.toBeInTheDocument();
  });

  it("clears busy state and explains a mutation whose timed-out outcome is unknown", async () => {
    overview.grants = applicationGrants();
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: /Applications/ }));
    await user.click(screen.getByText("Reading list"));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (new URL(String(input)).pathname === "/v1/grants/revoke-batch") {
        return new Promise<Response>(() => undefined);
      }
      return originalFetch(input, init);
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Revoke application" }));

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The request timed out after it may have reached the service. Refresh to confirm the current state before trying again."
    );
    expect(screen.getByRole("button", { name: "Revoke application" })).toBeEnabled();
  });

  it("aborts an in-flight management mutation on unmount without refreshing", async () => {
    overview.grants = applicationGrants();
    let mutationSignal: AbortSignal | undefined;
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (new URL(String(input)).pathname !== "/v1/grants/revoke-batch") {
        return originalFetch(input, init);
      }
      mutationSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        mutationSignal?.addEventListener("abort", () => reject(
          new DOMException("Aborted", "AbortError")
        ), { once: true });
      });
    });
    const user = userEvent.setup();
    const rendered = render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: /Applications/ }));
    await user.click(screen.getByText("Reading list"));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    await user.click(screen.getByRole("button", { name: "Revoke application" }));
    await waitFor(() => expect(mutationSignal).toBeDefined());
    const overviewCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === "/v1/me"
    ).length;

    rendered.unmount();
    expect(mutationSignal?.aborted).toBe(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(vi.mocked(fetch).mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === "/v1/me"
    )).toHaveLength(overviewCalls);
  });

  it("generates a one-use sharing code from account settings", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/hosted/collection-invitation-codes" && init?.method === "POST") {
        return Response.json({
          invitation_code: "ABCD-EFGH",
          expires_at: new Date(Date.now() + 86_400_000).toISOString()
        }, { status: 201 });
      }
      return originalFetch(input, init);
    });
    const user = userEvent.setup();
    render(<ConnectApp />);
    await user.click(await screen.findByRole("link", { name: /Account & sessions/ }));
    await user.click(await screen.findByRole("button", { name: "Generate code" }));

    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByText("A new one-use sharing code is ready.")).toBeInTheDocument();
  });

  it("explains a temporary account-deletion hold without offering the destructive action", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account/sessions") return Response.json({ sessions: [] });
      if (path === "/v1/account") {
        const account = accountFixture();
        return Response.json({
          ...account,
          deletion: {
            ...account.deletion,
            available: false,
            unavailable_reason: "temporarily_disabled"
          }
        });
      }
      return Response.json(overview);
    });
    const user = userEvent.setup();
    render(<ConnectApp />);

    await user.click(await screen.findByRole("link", { name: "Open account and sessions" }));
    expect(await screen.findByText(
      "Account deletion is temporarily unavailable while we complete a service correction."
    )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete account…" }))
      .not.toBeInTheDocument();
  });

  it("changes one optional email preference and keeps account email always on", async () => {
    let preferences = { announcements: true, product_updates: false };
    const requests: Array<{ path: string; method?: string; body?: string }> = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method, body: init?.body as string | undefined });
      if (path === "/v1/account/sessions") return Response.json({ sessions: [] });
      if (path === "/v1/account/email-preferences") {
        preferences = { ...preferences, ...JSON.parse(String(init?.body)) };
        return Response.json({ email_preferences: preferences });
      }
      if (path === "/v1/account") {
        return Response.json({ ...accountFixture(), email_preferences: preferences });
      }
      return Response.json(overview);
    });
    const user = userEvent.setup();
    render(<ConnectApp />);

    await user.click(await screen.findByRole("link", { name: "Open account and sessions" }));
    expect(await screen.findByRole("heading", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
    const announcements = screen.getByRole("checkbox", { name: /Announcements/ });
    expect(announcements).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Product updates/ })).not.toBeChecked();

    await user.click(announcements);

    expect(await screen.findByText("Announcements turned off.")).toBeInTheDocument();
    expect(requests).toContainEqual({
      path: "/v1/account/email-preferences",
      method: "PATCH",
      body: JSON.stringify({ announcements: false })
    });
    expect(screen.getByRole("checkbox", { name: /Announcements/ })).not.toBeChecked();
  });

  it("keeps hosted storage, sign-in methods, and account deletion in the editor", async () => {
    const user = userEvent.setup();
    render(<ConnectApp />);

    await user.click(await screen.findByRole("link", { name: "Open account and sessions" }));
    expect(await screen.findByRole("heading", { name: "Hosted storage" })).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Permanent allowance")).toBeInTheDocument();
    expect(screen.getByText("10 MB of 1 GB")).toBeInTheDocument();
    expect(screen.getByText("4 KB Markdown · 10 MB files")).toBeInTheDocument();
    expect(screen.getByText("2 MB of 2 GB retained file storage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument();
    expect(screen.getByText("Local collection files stay on your computers and are not measured here.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete account…" }));
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete account permanently" }));

    expect(await screen.findByRole("heading", { name: "Your account has been deleted." })).toBeInTheDocument();
    expect(location.pathname).toBe("/account-deleted");
    expect(screen.getByText(/local collection and mirror files remain/i)).toBeInTheDocument();
  });
});

function installationFixture(): NonNullable<ManagementOverview["installation_access"]>[number] {
  return { application_id: "registered-app", application_family_id: "reader-family", application_name: "Reader app", application_origin: "https://reader.example", icon: null, connector_id: "installation-connector", installation_id: "installation-11111111", device_kind: "app-runtime", created_at: "2026-01-01T12:00:00Z", create_collections: false, collection_id: "collection", collection_name: "Garden notes", sync: "cloud_copy", available: true, role: "owner", approved_optional_file_actions: [] };
}

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
        retained_file_bytes: 2_147_483_648,
        max_document_bytes: 2_097_152,
        max_single_file_bytes: 262_144_000,
        max_mirror_replicas_per_collection: 10,
        max_application_replicas_per_collection: 50,
        max_hosted_collections: 250,
        max_files_per_collection: 10_000,
        max_collection_member_seats: 10
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
    collection_sharing_available: true,
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

function applicationGrants(): ManagementOverview["grants"] {
  const now = new Date().toISOString();
  return ["grant-a", "grant-b"].map((id, index) => ({
    id,
    operations: ["read"],
    scope: { contracts: [], access: "full_collection" as const },
    created_at: now,
    revoked_at: null,
    revocation_status: "active" as const,
    reauthorization_required_at: null,
    reauthorization_reason: null,
    collection_id: index === 0 ? "collection" : "collection-two",
    collection_name: index === 0 ? "Garden notes" : "Research notes",
    collection_kind: "local" as const,
    application_id: "reading-list",
    application_name: "Reading list",
    distribution: "web" as const,
    homepage: "https://reading.example",
    project_url: null,
    application_origin: "https://reading.example",
    icon: null
  }));
}

function secondCollection(): ManagementOverview["collections"][number] {
  return {
    id: "collection-two", connector_id: "computer", local_id: "local-two", connector_name: "Home computer",
    display_name: "Research notes", spec_version: "1", enabled: true, contracts: [], last_seen_at: new Date().toISOString()
  };
}

function hostedCollection(): ManagementOverview["hosted_collections"][number] {
  return {
    id: "hosted",
    display_name: "Hosted research",
    template: "mdbase",
    provider_url: "https://storage.example",
    spec_version: "1",
    contracts: [],
    authority_state: "active",
    authority_epoch: 1,
    transferred_collection_id: null,
    created_at: new Date().toISOString(),
    access: {
      relationship: "owner",
      role: "owner",
      can_authorize_applications: true,
      can_manage_collection: true,
      can_rename_collection: true,
      can_delete_collection: true,
      can_manage_members: true
    },
    replicas: []
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
    email_preferences: { announcements: true, product_updates: false },
    deletion: {
      available: true,
      unavailable_reason: null,
      hosted_collections: 1,
      local_collections: 1,
      computers: 1,
      development_confirmation: true
    }
  };
}
