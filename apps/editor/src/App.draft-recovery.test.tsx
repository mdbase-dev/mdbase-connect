import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MdbaseConnectError } from "@mdbase-dev/connect";
import { connectProblem } from "@mdbase-dev/connect-testing";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label, readOnly }: { value: string; onChange?: (text: string) => void; label: string; readOnly?: boolean }) =>
    <textarea aria-label={label} readOnly={readOnly} value={value} onChange={(event) => onChange?.(event.target.value)} />
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
  expect(Object.keys(localStorage).some((key) => key.startsWith("mdbase-editor:draft:v1:"))).toBe(true);
  first.unmount();
  update.mockClear();
  render(<App gateway={gateway} />);
  const restore = await screen.findByRole("button", { name: "Restore unsaved edits" });
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveAttribute("readonly");
  fireEvent.click(restore);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Recovered unsent writing"));
  expect(screen.getByRole("textbox", { name: "Note body" })).not.toHaveAttribute("readonly");
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
