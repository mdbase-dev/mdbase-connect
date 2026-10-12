import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { connect, type MdbaseClient } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { COLLECTION_UNAVAILABLE_REASONS, mergeCollectionEntries, type CollectionAvailability, type MdbasePrivateCollection } from "@mdbase-dev/sdk/app-grant";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkEditorRoot, type EditorNativeScope } from "./SdkEditorRoot";
import type { PrivateCollections } from "./private-collections";
import { applicationFixture, closeNativeFixtures, paired } from "./test/native-fixture";

const RESEARCH = "0190a5a0-0000-7000-8000-000000000001";
const clients: MdbaseClient[] = [];
afterEach(() => { closeNativeFixtures(); for (const client of clients.splice(0)) client.close(); });

function privateEntry(availability: CollectionAvailability, collectionId = RESEARCH, displayName = "Research", role: MdbasePrivateCollection["role"] = null): MdbasePrivateCollection {
  return { collectionId, displayName, operations: ["read"], role, availability };
}

/** A fake grant surface: the real one needs Connect consent and a serving computer. */
function fakePrivate(entries: MdbasePrivateCollection[]) {
  let list = entries;
  const replica = new MemoryReplica({ confirmDelayMs: 0, collection: RESEARCH });
  const port = {
    collections: vi.fn(async () => list),
    authorize: vi.fn(async (collection?: string) => ({ collectionId: collection ?? RESEARCH })),
    waitForAvailable: vi.fn(async (_collection: string, options?: { onAvailability?(value: CollectionAvailability): void }): Promise<CollectionAvailability> => {
      const available: CollectionAvailability = { state: "available" };
      options?.onAvailability?.(available);
      return available;
    }),
    open: vi.fn(async () => {
      const client = await connect({ connector: replica.connector(), app: { name: "editor-private-test", version: "test" }, reconnect: false });
      clients.push(client);
      return client;
    }),
    forget: vi.fn(async () => undefined),
    merge: mergeCollectionEntries
  } satisfies PrivateCollections;
  return { port, replica, set(next: MdbasePrivateCollection[]) { list = next; } };
}

function signedIn() {
  return applicationFixture({ status: "unselected", signIn: paired,
    collections: [{ collectionId: "0190a5a0-0000-7000-8000-0000000000aa", displayName: "Notes", role: "editor" }] });
}

function Capture({ scope, publish }: { scope: EditorNativeScope; publish(scope: EditorNativeScope): void }) {
  useEffect(() => { publish(scope); }, [scope, publish]);
  return <p role="status">Private native consumer</p>;
}

const row = (name: string) => screen.getByRole("group", { name });

describe("Private collections in the editor chooser", () => {
  it("lists Private collections beside the shared gate's collections", async () => {
    const h = signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" }, RESEARCH, "Archive")]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    const archive = await screen.findByRole("group", { name: "Archive" });
    expect(within(archive).getByText("Private")).toBeTruthy();
    const section = screen.getByRole("region", { name: "Private collections" });
    expect(within(section).queryByText("Notes")).toBeNull();
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it.each(COLLECTION_UNAVAILABLE_REASONS)("shows the plain copy for %s", async (reason) => {
    const h = signedIn();
    const availability: CollectionAvailability = { state: "unavailable", reason };
    const fake = fakePrivate([privateEntry(availability)]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    await screen.findByRole("group", { name: "Research" });
    const copy = describeError(availability);
    if (!copy) throw new Error("missing copy");
    expect(within(row("Research")).getByText(copy.title)).toBeTruthy();
    expect(within(row("Research")).getByText(copy.message)).toBeTruthy();
  });

  it("approval on the computer: opening waits, then opens once it is available", async () => {
    const h = signedIn();
    const fake = fakePrivate([privateEntry({ state: "unavailable", reason: "approval_required" })]);
    const scopes: EditorNativeScope[] = [];
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port}
      renderNative={(scope) => <Capture scope={scope} publish={(next) => scopes.push(next)} />} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "Research" })).getByRole("button", { name: "Research" }));
    await screen.findByText("Private native consumer");
    expect(fake.port.waitForAvailable).toHaveBeenCalledWith(RESEARCH, expect.anything());
    expect(fake.port.open).toHaveBeenCalledWith(RESEARCH, expect.anything());
    const scope = scopes.at(-1);
    if (!scope) throw new Error("Missing native scope");
    expect(scope.connection.id).toBe(RESEARCH);
  });

  it("an available Private collection opens straight away, without the people directory", async () => {
    const h = signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const scopes: EditorNativeScope[] = [];
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port}
      renderNative={(scope) => <Capture scope={scope} publish={(next) => scopes.push(next)} />} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "Research" })).getByRole("button", { name: "Research" }));
    await screen.findByText("Private native consumer");
    expect(fake.port.waitForAvailable).not.toHaveBeenCalled();
    expect(scopes.at(-1)?.gateway.peopleDirectory).toBeUndefined();
  });

  it("unavailable rows offer the SDK's action label: approve again, get the update; access_removed offers no open", async () => {
    const h = signedIn();
    const other = "0190a5a0-0000-7000-8000-000000000002";
    const third = "0190a5a0-0000-7000-8000-000000000003";
    const fake = fakePrivate([privateEntry({ state: "unavailable", reason: "sync_required" }),
      privateEntry({ state: "unavailable", reason: "access_removed" }, other, "Shared"),
      privateEntry({ state: "unavailable", reason: "desktop_update_required" }, third, "Laptop")]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    await screen.findByRole("group", { name: "Research" });
    expect(within(row("Shared")).queryByRole("button", { name: "Shared" })).toBeNull();
    expect(within(row("Laptop")).getByRole("link", { name: "Get the update" }).getAttribute("href")).toMatch(/^https:\/\//);
    fireEvent.click(within(row("Research")).getByRole("button", { name: "Approve again" }));
    await waitFor(() => expect(fake.port.authorize).toHaveBeenCalledWith(RESEARCH, expect.anything()));
  });

  it("offers Delete only on Private collections the account owns, and drops one once deleted", async () => {
    const h = signedIn();
    const other = "0190a5a0-0000-7000-8000-000000000002";
    const fake = fakePrivate([privateEntry({ state: "available" }, RESEARCH, "Research", "owner"),
      privateEntry({ state: "available" }, other, "Shared", "editor")]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    await screen.findByRole("group", { name: "Research" });
    expect(within(row("Shared")).queryByRole("button", { name: "Delete Shared" })).toBeNull();
    // The relay stops listing a deleted collection; the section re-reads the list after the dialog.
    h.controls.setHandler("deleteCollection", () => { fake.set([privateEntry({ state: "available" }, other, "Shared", "editor")]); });
    fireEvent.click(within(row("Research")).getByRole("button", { name: "Delete Research" }));
    fireEvent.change(await screen.findByLabelText(/to confirm/), { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete collection" }));
    await waitFor(() => expect(h.controls.observedActions().some((call) => call.action === "deleteCollection")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Research" })).toBeNull());
    expect(screen.getByRole("group", { name: "Shared" })).toBeTruthy();
  });

  it("adding a Private collection asks Connect, then lists it", async () => {
    const h = signedIn();
    const fake = fakePrivate([]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    await screen.findByText("Notes");
    fake.set([privateEntry({ state: "unavailable", reason: "approval_required" })]);
    fake.port.waitForAvailable.mockResolvedValueOnce({ state: "unavailable", reason: "approval_required" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add a Private collection" })); });
    expect(fake.port.authorize).toHaveBeenCalledWith(undefined, expect.anything());
    await screen.findByRole("group", { name: "Research" });
  });
});
