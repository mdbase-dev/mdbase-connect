import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "./test/locale";
import { expect, it, vi } from "vitest";
import { MdbaseConnectError } from "./connect-types";
import { connectProblem } from "./connect-types";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ header, value, onChange, label, readOnly }: { header?: ReactNode; value: string; onChange?: (text: string) => void; label: string; readOnly?: boolean }) =>
    <>{header}<textarea aria-label={label} readOnly={readOnly} value={value} onChange={(event) => onChange?.(event.target.value)} /></>
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
  })
}));

it("offers unsent edits after a reload without writing them until the user restores", async () => {
  const gateway = new DemoCollectionGateway(3);
  const update = vi.spyOn(gateway, "update").mockRejectedValue(new MdbaseConnectError(connectProblem("connector_offline", "Offline")));
  const first = render(<App gateway={gateway} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Note body" }), { target: { value: "Recovered unsent writing" } });
  // The checkpoint waits for a pause in writing; closing the editor writes it at once.
  expect(Object.keys(localStorage).some((key) => key.startsWith("mdbase-editor:draft:v1:"))).toBe(false);
  first.unmount();
  expect(Object.keys(localStorage).some((key) => key.startsWith("mdbase-editor:draft:v1:"))).toBe(true);
  update.mockClear();
  render(<App gateway={gateway} />);
  const restore = await screen.findByRole("button", { name: "Restore unsaved edits" });
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveAttribute("readonly");
  expect(screen.getByText(/Editing is paused until you restore or discard these edits/)).toBeVisible();
  fireEvent.click(restore);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Recovered unsent writing"));
  expect(screen.getByRole("textbox", { name: "Note body" })).not.toHaveAttribute("readonly");
});

it("keeps Private collection text out of localStorage and erases older checkpoints", async () => {
  const gateway = new DemoCollectionGateway(3);
  const ready = gateway.sessionSnapshot.bind(gateway);
  vi.spyOn(gateway, "sessionSnapshot").mockImplementation(() => {
    const snapshot = ready();
    if (snapshot.status !== "ready") return snapshot;
    const connection = { ...snapshot.connection, private: true as const };
    return { ...snapshot, connection, connections: [connection] };
  });
  const isDraft = (key: string) => key.startsWith("mdbase-editor:draft:v1:");
  // An older build's checkpoint of this collection, before it was known to be Private.
  const first = render(<App gateway={new DemoCollectionGateway(3)} />);
  vi.spyOn(DemoCollectionGateway.prototype, "update").mockRejectedValue(new MdbaseConnectError(connectProblem("connector_offline", "Offline")));
  fireEvent.change(await screen.findByRole("textbox", { name: "Note body" }), { target: { value: "Old plain checkpoint" } });
  first.unmount();
  expect(Object.keys(localStorage).some(isDraft)).toBe(true);
  render(<App gateway={gateway} />);
  await waitFor(() => expect(Object.keys(localStorage).filter(isDraft)).toEqual([]));
  fireEvent.change(await screen.findByRole("textbox", { name: "Note body" }), { target: { value: "Private writing" } });
  expect(Object.keys(localStorage).filter(isDraft)).toEqual([]);
  expect(screen.queryByRole("button", { name: "Restore unsaved edits" })).toBeNull();
  expect(screen.queryByText(/cannot be backed up/)).toBeNull();
});

it("discards a recovered copy without changing the authoritative record", async () => {
  const gateway = new DemoCollectionGateway(1);
  const first = render(<App gateway={gateway} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Note body" }), { target: { value: "Discard me" } });
  first.unmount();
  const update = vi.spyOn(gateway, "update").mockRejectedValue(new MdbaseConnectError(connectProblem("connector_offline", "Offline")));
  render(<App gateway={gateway} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discard recovered edits" }));
  expect(screen.getByRole("textbox", { name: "Note body" })).not.toHaveValue("Discard me");
  expect(Object.keys(localStorage).filter((key) => key.startsWith("mdbase-editor:draft:v1:"))).toEqual([]);
  expect(update).not.toHaveBeenCalled();
});

it("opens already-saved recovery text without a recovery banner or a read-only body", async () => {
  const gateway = new DemoCollectionGateway(1);
  const first = render(<App gateway={gateway} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Note body" }), { target: { value: "Already saved writing" } });
  fireEvent(window, new Event("pagehide"));
  const key = Object.keys(localStorage).find((key) => key.startsWith("mdbase-editor:draft:v1:"))!;
  const checkpoint = localStorage.getItem(key)!;
  await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  first.unmount();
  // An old crash checkpoint can outlive the exact native write that saved it.
  localStorage.setItem(key, checkpoint);
  render(<App gateway={gateway} />);
  const body = await screen.findByRole("textbox", { name: "Note body" });
  await waitFor(() => expect(body).toHaveValue("Already saved writing"));
  expect(body).not.toHaveAttribute("readonly");
  expect(screen.queryByRole("button", { name: "Restore unsaved edits" })).not.toBeInTheDocument();
  expect(localStorage.getItem(key)).toBeNull();
});

it("says when this browser refuses the recovery copy", async () => {
  const gateway = new DemoCollectionGateway(1);
  vi.spyOn(gateway, "update").mockRejectedValue(new MdbaseConnectError(connectProblem("connector_offline", "Offline")));
  render(<App gateway={gateway} />);
  const body = await screen.findByRole("textbox", { name: "Note body" });
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith("mdbase-editor:draft:v1:")) throw new DOMException("Full", "QuotaExceededError");
    setItem.call(this, key, value);
  });
  fireEvent.change(body, { target: { value: "Writing with nowhere to go" } });
  expect(screen.queryByText(/cannot be backed up/)).toBeNull();
  fireEvent(window, new Event("pagehide"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unsaved edits cannot be backed up in this browser.");
});
