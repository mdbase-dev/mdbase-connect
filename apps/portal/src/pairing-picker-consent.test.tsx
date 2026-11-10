import { act, fireEvent, render, screen, within } from "./test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pairing } from "./authority-workflows";
import { api, type DevicePairing } from "./api";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: vi.fn() }));
afterEach(() => vi.useRealTimers());

async function fixture(extra: Partial<DevicePairing> = {}) {
  let selected = false, attested = false, approved = false, selectedCollectionId = "";
  let catalog = [{ collection_id: "notes", display_name: "Notes", role: "owner" }];
  const state = () => ({ connector_name: "Reader", approved_at: approved ? "approved" : null,
    installation_device: true, account_upgraded: true, app_origin: "https://reader.example",
    account_selection_confirmed: selected, signed_in_account_email: "owner@example.test",
    account_email: selected ? "owner@example.test" : null, attested,
    fingerprint: attested ? "1234-5678" : null, selected_collection_id: selectedCollectionId, collections: catalog, ...extra });
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === "POST") {
      if (path.endsWith("/select-account")) selected = true;
      else if (path.endsWith("/approve")) { approved = true; selectedCollectionId = JSON.parse(String(options.body)).selected_collection_id; }
      else throw new Error(`Unexpected mutation: ${path}`);
      return {};
    }
    return { pairing: state() };
  });
  const view = render(<Pairing pairingId="original" />);
  const picker = await screen.findByRole("listbox", { name: "Open in Reader" });
  const posts = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST");
  const choose = () => fireEvent.click(screen.getByRole("option", { name: extra.collections?.[0]?.display_name ?? "Notes" }));
  return { ...view, picker, posts, choose, attest: () => { attested = true; }, remove: () => { catalog = []; } };
}

describe("one explicit collection consent", () => {
  it("keeps collection-creation authority and retained access beside the decision", async () => {
    const view = await fixture({ requested_create_collections: true, scope_only: true });
    const receipt = within(document.querySelector<HTMLElement>(".approval-receipt")!);
    expect(receipt.getByText("Allow Reader to create new collections")).toBeVisible();
    expect(receipt.getByText("Already-allowed access stays in place. Revoke access separately if you no longer want it.")).toBeVisible();
    fireEvent.click(screen.getByText("Allow offline access to additional collections"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow Reader to create new collections" }));
    expect(receipt.queryByText("Allow Reader to create new collections")).not.toBeInTheDocument();
    expect(view.posts()).toEqual([]);
  });
  it.each(["http://127.0.0.1:49152", "http://localhost:5173", "http://[::1]:5173"])("describes pairing from %s as an unverified app running on this computer", async app_origin => {
    const f = await fixture({app_origin});
    expect(screen.getByRole("note")).toHaveTextContent("App identity unverified. This app calls itself Reader.");
    expect(f.posts()).toEqual([]);
  });
  it.each(["https://remote.example.test", "http://127.0.0.2:49152", undefined])("shows the actual pairing origin instead of local wording for %s", async app_origin => {
    await fixture({app_origin});
    expect(screen.queryByText(/Requested by an app running on this computer/)).not.toBeInTheDocument();
    if (app_origin) expect(document.querySelector(".request-origin code")).toHaveTextContent(app_origin);
  });
  it("lands directly on the picker with app/origin/warning, and no account or approval mutation", async () => {
    const f = await fixture();
    expect(f.picker.parentElement?.querySelector("select")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Open in Reader" })).toBeInTheDocument();
    expect(within(f.picker).queryAllByRole("option", { selected: true })).toEqual([]);
    expect(screen.queryByRole("button", { name: "Use this account" })).not.toBeInTheDocument();
    expect(screen.queryByText(/mdbase was upgraded/)).not.toBeInTheDocument();
    expect(document.querySelector(".request-origin code")).toHaveTextContent("https://reader.example");
    expect(screen.getByText(/Continue only if you started this and recognize this site\./)).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Open in Reader" }), { target: { value: "Notes" } });
    f.choose(); fireEvent.keyDown(f.picker, { key: "Enter" });
    expect(f.posts()).toEqual([]);
  });

  it("one confirm selects the account, waits for actual attestation, then approves the selected collection", async () => {
    const f = await fixture(); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(f.posts().map(([path]) => path.split("/").at(-1))).toEqual(["select-account"]);
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
    f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.posts().map(([path]) => path.split("/").at(-1))).toEqual(["select-account", "approve"]);
    expect(JSON.parse(f.posts()[1][1]!.body as string)).toEqual({ fingerprint: "1234-5678", collection_ids: ["notes"], create_collections: false, selected_collection_id: "notes" });
    expect(screen.getByRole("heading", { name: "Reader can now use Notes" })).toBeInTheDocument();
  });

  it("keeps the informational device key under Details after preparation and on the approved screen", async () => {
    const f = await fixture(); f.choose();
    const implementation = vi.mocked(api).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (path.endsWith("/approve")) await new Promise<void>(resolve => { finish = resolve; });
      return implementation(path, options);
    });
    vi.useFakeTimers(); fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ })); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
    expect(screen.getByText("1234-5678").closest("details")).toHaveClass("installation-details");
    await act(async () => { finish(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { name: "Reader can now use Notes" })).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("1234-5678").closest("details")).toHaveClass("installation-details");
  });

  it("stops at the bounded preparation deadline; reads and explicit retry never replay approval", async () => {
    const f = await fixture(); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't prepare Reader/);
    expect(f.posts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    f.attest(); fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.posts().map(([path]) => path.split("/").at(-1))).toEqual(["select-account", "approve"]);
  });

  it("bounds a hung read and retries without repeating successful account selection, even without a refreshed snapshot", async () => {
    const f = await fixture(); f.choose();
    const implementation = vi.mocked(api).getMockImplementation()!;
    let hung = true;
    vi.mocked(api).mockImplementation((path, options) => options?.method === "POST" || !hung ? implementation(path, options) : new Promise(() => {}));
    vi.useFakeTimers(); fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't prepare Reader/);
    expect(f.posts()).toHaveLength(1);
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.signal)).toHaveLength(1);
    hung = false; f.attest(); fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.posts().map(([path]) => path.split("/").at(-1))).toEqual(["select-account", "approve"]);
  });

  it("does not treat the successful-call marker as server account-confirmation authority", async () => {
    const f = await fixture({account_selection_confirmed:false}); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ })); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't prepare Reader/);
    expect(f.posts().map(([path]) => path.split("/").at(-1))).toEqual(["select-account"]);
  });

  it("lists cloud and Private together, labels Private, and never selects a server hint on load", async () => {
    const f = await fixture({collection_hint:"private", collections:[
      {collection_id:"notes",display_name:"Notes",role:"owner"},
      {collection_id:"private",display_name:"Private notes",role:"member",kind:"private"},
    ]});
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(within(f.picker).getAllByRole("option")).toHaveLength(2);
    const privateRow = screen.getByRole("option", {name:"Private notes"});
    expect(privateRow).toHaveAccessibleDescription("Private collection — on your computers · Shared with you");
    expect(privateRow).toHaveAttribute("data-value", "private");
    expect(within(f.picker).queryAllByRole("option", {selected:true})).toEqual([]);
    expect(screen.getByRole("button", {name:"Open Reader"})).toBeDisabled();
    fireEvent.click(privateRow);
    expect(screen.getByRole("button", {name:"Open Reader"})).toBeEnabled();
    expect(f.posts()).toEqual([]);
  });

  it("restores the person's unfinished creation ahead of an earlier recorded selection or hint", async () => {
    const f = await fixture({can_create_collection:true, selected_collection_id:"notes", collection_hint:"notes",
      creation:{collection_id:"creating",display_name:"Original creation",completed:false}});
    expect(screen.getByRole("combobox", {name:"Open in Reader"})).toHaveAttribute("data-value", "new-collection");
    expect(screen.getByRole("button", {name:"Create a new collection…"})).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", {name:"New collection name"})).toHaveValue("Original creation");
    expect(screen.getByRole("textbox", {name:"New collection name"})).toHaveAttribute("readonly");
    expect(screen.getByRole("button", {name:"Open Reader"})).toBeEnabled();
    expect(f.posts()).toEqual([]);
  });

  it("restores the server-recorded choice ahead of completed creation or an unrelated hint", async () => {
    const f = await fixture({selected_collection_id:"notes", collection_hint:"not-the-choice",
      creation:{collection_id:"created",display_name:"Earlier creation",completed:true}});
    expect(screen.getByRole("combobox", {name:"Open in Reader"})).toHaveAttribute("data-value", "notes");
    expect(screen.getByRole("option", {name:"Notes"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", {name:"Open Reader"})).toBeEnabled();
    expect(f.posts()).toEqual([]);
  });

  it("restores the person's completed creation when no separate choice was recorded", async () => {
    const f = await fixture({collection_hint:"not-the-choice",
      creation:{collection_id:"notes",display_name:"Notes",completed:true}});
    expect(screen.getByRole("combobox", {name:"Open in Reader"})).toHaveAttribute("data-value", "notes");
    expect(screen.getByRole("option", {name:"Notes"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", {name:"Open Reader"})).toBeEnabled();
    expect(f.posts()).toEqual([]);
  });

  it("waits for the original native companion, not just its catalog entry and attestation", async () => {
    const binding: Partial<DevicePairing> = {collections:[{collection_id:"notes",display_name:"Private notes",role:"owner",kind:"private"}],native_authorization_id:null};
    const f = await fixture(binding); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ })); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.posts()).toHaveLength(1);
    binding.native_authorization_id = "original-native";
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(JSON.parse(f.posts()[1][1]!.body as string)).toEqual({fingerprint:"1234-5678",collection_ids:[],create_collections:false,selected_collection_id:"notes",selected_collection_kind:"private"});
  });

  it("never approves after the displayed account identity changes", async () => {
    const f = await fixture({account_email:"changed@example.test"}); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ })); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("alert")).toHaveTextContent(/signed-in account changed/);
    expect(f.posts()).toHaveLength(1);
  });

  it("never approves a collection withdrawn while preparing", async () => {
    const f = await fixture(); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    f.remove(); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer available/);
    expect(f.posts()).toHaveLength(1);
  });

  it("cancels the pending original confirmation on unmount", async () => {
    const f = await fixture(); f.choose(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Open Reader(?: with .+)?$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    f.unmount(); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(f.posts()).toHaveLength(1);
  });

  it.each([undefined, "", "   "])("never renders an empty origin (%s)", async app_origin => {
    await fixture({ app_origin });
    fireEvent.click(screen.getByText("Details"));
    expect(document.querySelector(".request-guidance")).toHaveTextContent("No requesting origin is available. Continue only if you started this connection intentionally.");
    expect(screen.getByText(/Requested by Reader\./)).toHaveTextContent("No requesting origin is available.");
    expect(document.body.textContent).not.toContain("Requested from .");
    expect(document.querySelectorAll("code")).toHaveLength(0);
  });
});

describe("device access to a Private collection", () => {
  const asked: Partial<DevicePairing> = { requested_private_device: true, collections: [
    { collection_id: "notes", display_name: "Notes", role: "owner" },
    { collection_id: "vault", display_name: "Vault", role: "owner", kind: "private_device" },
    { collection_id: "team", display_name: "Team", role: "editor", kind: "private_device" },
  ] };
  const keyCopy = "Reader on this device will hold the key to the private collections you allow here and will be able to read them. It will ask for your encryption password. Only allow this if you trust Reader with that password.";
  const receipt = () => within(document.querySelector<HTMLElement>(".approval-receipt")!);
  async function approve(f: Awaited<ReturnType<typeof fixture>>) {
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Open Reader" })); f.attest();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(f.posts().map(([path]) => path.split("/").at(-1))).toEqual(["select-account", "approve"]);
    return JSON.parse(f.posts()[1][1]!.body as string);
  }

  it("labels the choice and says, beside the decision, that this device will hold the key", async () => {
    const f = await fixture(asked);
    expect(screen.getByRole("option", { name: "Vault" })).toHaveAccessibleDescription("Private collection — key kept on this device");
    expect(screen.getByRole("option", { name: "Team" })).toHaveAccessibleDescription("Private collection — key kept on this device · Shared with you");
    expect(screen.getByRole("option", { name: "Notes" })).toHaveAccessibleDescription("Cloud copy");
    expect(receipt().queryByText(keyCopy)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Vault" }));
    expect(receipt().getByText(keyCopy)).toBeVisible();
    expect(receipt().getByText("Private collection — key kept on this device")).toBeVisible();
    // Not the app-grant path: nothing here opens through a computer.
    expect(screen.queryByText(/This collection stays on your computer/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Notes" }));
    expect(receipt().queryByText(keyCopy)).not.toBeInTheDocument();
    expect(f.posts()).toEqual([]);
  });

  it("approves it in its own list, never as the selected collection, an app grant or a reminder target", async () => {
    const f = await fixture({ ...asked, timer_declaration: { digest: "declared" } });
    expect(screen.getByRole("checkbox", { name: "Allow Reader to send you reminders" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Vault" }));
    expect(screen.queryByRole("checkbox", { name: "Allow Reader to send you reminders" })).not.toBeInTheDocument();
    expect(await approve(f)).toEqual({ fingerprint: "1234-5678", collection_ids: [], create_collections: false, private_device_collection_ids: ["vault"] });
    expect(screen.getByRole("heading", { name: "Access approved" })).toBeInTheDocument();
  });

  it("adds it beside a cloud copy opened in the app, with the same notice", async () => {
    const f = await fixture(asked);
    fireEvent.click(screen.getByRole("option", { name: "Notes" }));
    fireEvent.click(screen.getByText("Allow offline access to additional collections"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Team/ }));
    expect(receipt().getByText(keyCopy)).toBeVisible();
    expect(await approve(f)).toEqual({ fingerprint: "1234-5678", collection_ids: ["notes"], create_collections: false, selected_collection_id: "notes", private_device_collection_ids: ["team"] });
  });

  it("keeps device access it already has, offers to revoke it, and does not ask for it again", async () => {
    const f = await fixture({ ...asked, scope_only: true, retained_collection_ids: [], retained_private_device_collection_ids: ["vault"] });
    fireEvent.click(screen.getByRole("option", { name: "Notes" }));
    fireEvent.click(screen.getByText("Allow offline access to additional collections"));
    const kept = screen.getByRole("checkbox", { name: /Vault.*already allowed/ });
    expect(kept).toBeChecked(); expect(kept).toBeDisabled();
    expect(within(kept.closest<HTMLElement>(".installation-additional-collection")!).getByRole("button", { name: "Revoke access" })).toBeEnabled();
    expect(receipt().queryByText(keyCopy)).not.toBeInTheDocument();
    expect(await approve(f)).toEqual({ fingerprint: "1234-5678", collection_ids: ["notes"], create_collections: false, selected_collection_id: "notes" });
  });
});
