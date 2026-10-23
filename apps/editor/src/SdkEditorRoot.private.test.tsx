import { act, fireEvent, render, screen, waitFor, within } from "./test/locale";
import { StrictMode, useEffect } from "react";
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
    authorize: vi.fn(async (collection?: string, _options?: { signal?: AbortSignal }) => ({ collectionId: collection ?? RESEARCH })),
    waitForAvailable: vi.fn(async (_collection: string, options?: { signal?: AbortSignal; onAvailability?(value: CollectionAvailability): void }): Promise<CollectionAvailability> => {
      const available: CollectionAvailability = { state: "available" };
      options?.onAvailability?.(available);
      return available;
    }),
    open: vi.fn(async (_collection: string, _options?: { signal?: AbortSignal }) => {
      const client = await connect({ connector: replica.connector(), app: { name: "editor-private-test", version: "test" }, reconnect: false });
      clients.push(client);
      return client;
    }),
    forget: vi.fn(async (_collection: string): Promise<void> => undefined),
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

const accountChanges = ["account switch", "sign out", "same-account restart", "account round trip"] as const;
function changeAccount(h: Awaited<ReturnType<typeof signedIn>>, change: typeof accountChanges[number]) {
  const snapshot = h.mdbase.getSnapshot();
  if (!snapshot.signIn) throw new Error("expected signed-in fixture");
  if (change === "sign out" || change === "same-account restart") h.set("signed_out");
  else h.controls.publishSnapshot({ ...snapshot, signIn: { ...snapshot.signIn, accountId: "0190a5a0-0000-7000-8000-000000000099" } });
  if (change === "same-account restart" || change === "account round trip") h.controls.publishSnapshot(snapshot);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
async function openHistorical(h: Awaited<ReturnType<typeof signedIn>>, fake: ReturnType<typeof fakePrivate>, strict = false) {
  const scopes: EditorNativeScope[] = [];
  const root = <SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port}
    renderNative={(scope) => <Capture scope={scope} publish={(next) => scopes.push(next)} />} />;
  const view = render(strict ? <StrictMode>{root}</StrictMode> : root);
  fireEvent.click(await row("Research"));
  // Capture publishes from a passive effect: DOM appearance is not its completion barrier.
  await waitFor(() => expect(scopes.at(-1)?.connection.isCurrent()).toBe(true));
  const scope = scopes.at(-1)!;
  return { scope, unmount: view.unmount, close: vi.spyOn(scope.connection.records, "close") };
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
    await waitFor(() => expect(scopes.at(-1)?.connection.id).toBe(RESEARCH));
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
    await waitFor(() => expect(scopes.at(-1)?.connection.isCurrent()).toBe(true));
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

  it.each(accountChanges)("%s aborts a historical wait and ignores its late availability", async (change) => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "unavailable", reason: "approval_required" })]);
    const waiting = deferred<CollectionAvailability>();
    fake.port.waitForAvailable.mockImplementationOnce(() => waiting.promise);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} renderNative={() => <p>Historical scope</p>} />);
    fireEvent.click(await row("Research"));
    await waitFor(() => expect(fake.port.waitForAvailable).toHaveBeenCalledOnce());
    const signal = fake.port.waitForAvailable.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await act(async () => { changeAccount(h, change); waiting.resolve({ state: "available" }); });
    expect(signal?.aborted).toBe(true);
    expect(fake.port.open).not.toHaveBeenCalled();
    expect(screen.queryByText("Historical scope")).toBeNull();
  });

  it.each(accountChanges)("%s retires and closes an already-open historical scope", async (change) => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const opened = await openHistorical(h, fake);
    await act(async () => { changeAccount(h, change); });
    expect(opened.scope.connection.isCurrent()).toBe(false);
    expect(opened.close).toHaveBeenCalledOnce();
    expect(screen.queryByText("Private native consumer")).toBeNull();
  });

  it("aborts in-flight historical scope reauthorization on account switch", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const opened = await openHistorical(h, fake);
    const authorization = deferred<{ collectionId: string }>();
    fake.port.authorize.mockImplementationOnce(() => authorization.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = opened.scope.application.reauthorize(); void pending.catch(() => {}); });
    const signal = fake.port.authorize.mock.calls[0]?.[1]?.signal;
    await act(async () => { changeAccount(h, "account switch"); authorization.resolve({ collectionId: RESEARCH }); });
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it("preserves supplied cancellation without retiring the existing historical scope", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const opened = await openHistorical(h, fake);
    const authorization = deferred<{ collectionId: string }>();
    fake.port.authorize.mockImplementationOnce(() => authorization.promise);
    const caller = new AbortController();
    let pending!: Promise<unknown>;
    act(() => { pending = opened.scope.application.reauthorize({ signal: caller.signal }); void pending.catch(() => {}); });
    const signal = fake.port.authorize.mock.calls[0]?.[1]?.signal;
    await act(async () => { caller.abort(); authorization.resolve({ collectionId: RESEARCH }); });
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(opened.scope.connection.isCurrent()).toBe(true);
    expect(opened.close).not.toHaveBeenCalled();
  });

  it("leaving a historical scope cancels its in-flight reauthorization", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const opened = await openHistorical(h, fake);
    const authorization = deferred<{ collectionId: string }>();
    fake.port.authorize.mockImplementationOnce(() => authorization.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = opened.scope.application.reauthorize(); void pending.catch(() => {}); });
    const signal = fake.port.authorize.mock.calls[0]?.[1]?.signal;
    await act(async () => { await opened.scope.application.chooseAnother(); authorization.resolve({ collectionId: RESEARCH }); });
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(opened.scope.connection.isCurrent()).toBe(false);
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it("rejects retained historical actions before starting new authority work", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const opened = await openHistorical(h, fake);
    await act(async () => { changeAccount(h, "account switch"); });
    const selects = h.calls("select").length;
    await expect(opened.scope.application.reauthorize()).rejects.toMatchObject({ name: "AbortError" });
    await expect(opened.scope.application.select(RESEARCH)).rejects.toMatchObject({ name: "AbortError" });
    await expect(opened.scope.application.forget(RESEARCH)).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.port.authorize).not.toHaveBeenCalled();
    expect(fake.port.forget).not.toHaveBeenCalled();
    expect(h.calls("select")).toHaveLength(selects);
  });

  it("does not remove a next-session row after a late forget completion", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "unavailable", reason: "access_removed" })]);
    const forgotten = deferred<void>();
    fake.port.forget.mockImplementationOnce(() => forgotten.promise);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    fireEvent.click(await row("Research"));
    await waitFor(() => expect(fake.port.forget).toHaveBeenCalledOnce());
    fake.set([privateEntry({ state: "available" }, RESEARCH, "Refreshed row")]);
    await act(async () => { changeAccount(h, "account switch"); });
    expect(await row("Refreshed row")).toBeTruthy();
    await act(async () => { forgotten.resolve(); });
    expect(await row("Refreshed row")).toBeTruthy();
  });

  it("closes a late open result exactly once without publishing it", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const client = await fake.port.open(RESEARCH);
    const close = vi.spyOn(client, "close");
    fake.port.open.mockClear();
    const opening = deferred<MdbaseClient>();
    fake.port.open.mockImplementationOnce(() => opening.promise);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} renderNative={() => <p>Historical scope</p>} />);
    fireEvent.click(await row("Research"));
    await waitFor(() => expect(fake.port.open).toHaveBeenCalledOnce());
    await act(async () => { changeAccount(h, "account switch"); opening.resolve(client); });
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByText("Historical scope")).toBeNull();
  });

  it("an old operation cannot release a newer operation's busy guard", async () => {
    const h = await signedIn();
    const unavailable: CollectionAvailability = { state: "unavailable", reason: "approval_required" };
    const fake = fakePrivate([privateEntry(unavailable), privateEntry(unavailable, "0190a5a0-0000-7000-8000-000000000002", "Second")]);
    const first = deferred<CollectionAvailability>();
    const second = deferred<CollectionAvailability>();
    fake.port.waitForAvailable.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    render(<SdkEditorRoot sdk={h.mdbase} privateCollections={fake.port} />);
    fireEvent.click(await row("Research"));
    await waitFor(() => expect(fake.port.waitForAvailable).toHaveBeenCalledTimes(1));
    await act(async () => { changeAccount(h, "account switch"); });
    fireEvent.click(await row("Second"));
    await waitFor(() => expect(fake.port.waitForAvailable).toHaveBeenCalledTimes(2));
    await act(async () => { first.resolve(unavailable); });
    fireEvent.click(await row("Research"));
    expect(fake.port.waitForAvailable).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(unavailable); });
  });

  it("StrictMode unmount closes an owned historical client exactly once", async () => {
    const h = await signedIn();
    const fake = fakePrivate([privateEntry({ state: "available" })]);
    const opened = await openHistorical(h, fake, true);
    opened.unmount();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.scope.connection.isCurrent()).toBe(false);
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
