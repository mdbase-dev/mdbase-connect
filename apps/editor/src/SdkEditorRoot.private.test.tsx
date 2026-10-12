import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { connect, type MdbaseClient } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { COLLECTION_UNAVAILABLE_REASONS, mergeCollectionEntries, type CollectionAvailability, type MdbasePrivateCollection } from "@mdbase-dev/sdk/app-grant";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkEditorRoot, type EditorNativeScope } from "./SdkEditorRoot";
import type { PrivateCollections } from "./private-collections";
import { closeNativeFixtures, testApp } from "./test/native-fixture";

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
  return testApp({ collections: [{ name: "Notes", role: "editor" }], phase: "choosing" });
}

function Capture({ scope, publish }: { scope: EditorNativeScope; publish(scope: EditorNativeScope): void }) {
  useEffect(() => { publish(scope); }, [scope, publish]);
  return <p role="status">Private native consumer</p>;
}

const section = () => screen.findByRole("region", { name: "Private collections" });
const row = async (name: string) => within(await section()).getByRole("button", { name: new RegExp(`^${name}`) });

describe("Private collections in the editor chooser", () => {
  it("lists Private collections in their own section beside the shared gate's collections", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" }, RESEARCH, "Archive")]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    expect(await row("Archive")).toBeTruthy();
    expect(within(await section()).queryByText("Notes")).toBeNull();
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it.each(COLLECTION_UNAVAILABLE_REASONS)("shows the plain copy for %s", async (reason) => {
    const h = await signedIn();
    const availability: CollectionAvailability = { state: "unavailable", reason };
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fakePrivate([privateEntry(availability)]).port} />);
    const copy = describeError(availability);
    if (!copy) throw new Error("missing copy");
    expect(await row("Research")).toHaveTextContent(copy.title);
  });

  it("approval on the computer: opening waits, then opens once it is available", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "unavailable", reason: "approval_required" })]);
    const scopes: EditorNativeScope[] = [];
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port}
      renderNative={(scope) => <Capture scope={scope} publish={(next) => scopes.push(next)} />} />);
    fireEvent.click(await row("Research"));
    await screen.findByText("Private native consumer");
    expect(fake.port.waitForAvailable).toHaveBeenCalledWith(RESEARCH, expect.anything());
    expect(fake.port.open).toHaveBeenCalledWith(RESEARCH, expect.anything());
    expect(scopes.at(-1)?.connection.id).toBe(RESEARCH);
  });

  it("an available Private collection opens straight away, without the people directory", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const scopes: EditorNativeScope[] = [];
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port}
      renderNative={(scope) => <Capture scope={scope} publish={(next) => scopes.push(next)} />} />);
    fireEvent.click(await row("Research"));
    await screen.findByText("Private native consumer");
    expect(fake.port.waitForAvailable).not.toHaveBeenCalled();
    expect(scopes.at(-1)?.gateway.peopleDirectory).toBeUndefined();
  });

  it("unavailable rows do the SDK's fix: approve again, get the update, or remove a collection whose access ended", async () => {
    const h = await signedIn();
    const other = "0190a5a0-0000-7000-8000-000000000002";
    const third = "0190a5a0-0000-7000-8000-000000000003";
    const fake = fakePrivate([privateEntry({ state: "unavailable", reason: "sync_required" }),
      privateEntry({ state: "unavailable", reason: "access_removed" }, other, "Shared"),
      privateEntry({ state: "unavailable", reason: "desktop_update_required" }, third, "Laptop")]);
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    fireEvent.click(await row("Laptop"));
    expect(popup).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\//), "_blank", "noreferrer");
    fireEvent.click(await row("Shared"));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Private collections" })).queryByRole("button", { name: /^Shared/ })).toBeNull());
    expect(fake.port.forget).toHaveBeenCalledWith(other);
    expect(fake.port.open).not.toHaveBeenCalled();
    fireEvent.click(await row("Research"));
    await waitFor(() => expect(fake.port.authorize).toHaveBeenCalledWith(RESEARCH, expect.anything()));
    popup.mockRestore();
  });

  it("adding a Private collection asks Connect, then lists it", async () => {
    const h = await signedIn();
    const fake = fakePrivate([]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    await screen.findByText("Notes");
    fake.set([privateEntry({ state: "unavailable", reason: "approval_required" })]);
    fake.port.waitForAvailable.mockResolvedValueOnce({ state: "unavailable", reason: "approval_required" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add a Private collection" })); });
    expect(fake.port.authorize).toHaveBeenCalledWith(undefined, expect.anything());
    expect(await row("Research")).toBeTruthy();
  });

  it("offers Delete only on Private collections the account owns, confirms by name, and drops one once deleted", async () => {
    const h = await signedIn();
    const other = "0190a5a0-0000-7000-8000-000000000002";
    const fake = fakePrivate([privateEntry({ state: "available" }, RESEARCH, "Research", "owner"),
      privateEntry({ state: "available" }, other, "Shared", "editor")]);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    await row("Research");
    const region = await section();
    expect(within(region).queryByRole("button", { name: "More for Shared" })).toBeNull();
    // The relay stops listing a deleted collection; the section re-reads the list after the dialog.
    h.controls.setHandler("deleteCollection", () => { fake.set([privateEntry({ state: "available" }, other, "Shared", "editor")]); });
    fireEvent.click(within(region).getByRole("button", { name: "More for Research" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete collection…" }));
    expect(h.calls("deleteCollection")).toHaveLength(0);
    fireEvent.change(await screen.findByLabelText(/to confirm/), { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete collection" }));
    await waitFor(() => expect(h.calls("deleteCollection")).toHaveLength(1));
    await waitFor(() => expect(within(region).queryByRole("button", { name: /^Research/ })).toBeNull());
    expect(await row("Shared")).toBeTruthy();
  });
});
