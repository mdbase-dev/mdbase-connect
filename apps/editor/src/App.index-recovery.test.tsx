import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionChange, WatchStatus } from "@mdbase-dev/connect";
import type { NoteContentRequest, NoteIndexRequest } from "./model";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, label }: { value: string; label: string }) =>
    <textarea aria-label={label} value={value} readOnly />
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: Math.min(count, 20) }, (_, index) =>
      ({ index, start: index * 76, size: 76 }))
  })
}));

it("shows a stopped connection and explicit retry after a permanent watch failure", async () => {
  let rejectWatch!: (error: Error) => void;
  class FailedWatchGateway extends DemoCollectionGateway {
    async watch(_onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void) {
      onStatus?.({ state: "connected", cursor: 1, recovered: false });
      await new Promise<void>((resolve, reject) => {
        rejectWatch = reject;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
  const { unmount } = render(<App gateway={new FailedWatchGateway(3)} />);
  try {
    await screen.findByRole("textbox", { name: "Note body" });
    await waitFor(() => expect(rejectWatch).toBeTypeOf("function"));
    await act(async () => rejectWatch(new Error("Watch access revoked")));
    expect(await screen.findByRole("status", { name: "Collection stopped" })).toHaveTextContent("Sync stopped");
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Collection connected" })).not.toBeInTheDocument();
  } finally { unmount(); }
});

it("retries the failed inventory and starts full-text indexing only after all notes load", async () => {
  class InterruptedGateway extends DemoCollectionGateway {
    fail = true;
    async list(options: NoteIndexRequest = {}) {
      const result = await super.list({ signal: options.signal });
      const notes = result.notes.map(({ body: _body, ...note }) => note);
      if (!this.fail) {
        options.onProgress?.({ notes, total: notes.length, structureComplete: true, complete: true, contentComplete: false });
        return { ...result, notes };
      }
      options.onProgress?.({ notes: notes.slice(0, 400), total: notes.length,
        structureComplete: false, complete: false, contentComplete: false });
      throw new Error("Third page unavailable");
    }
    async hydrateContent(options: NoteContentRequest = {}) {
      const result = await super.hydrateContent({ signal: options.signal });
      return { ...result, notes: result.notes.map((note) => ({ ...note, body: "recoveryneedle" })) };
    }
  }
  const gateway = new InterruptedGateway(600);
  const hydrate = vi.spyOn(gateway, "hydrateContent");
  render(<App gateway={gateway} />);
  expect(await screen.findByText("400 notes loaded · incomplete")).toBeInTheDocument();
  expect(hydrate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "recoveryneedle" } });
  expect(await screen.findByText("0 found so far · incomplete")).toBeInTheDocument();
  gateway.fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry notes" }));
  await waitFor(() => expect(hydrate).toHaveBeenCalledOnce());
  expect(await screen.findByText("600 found · relevance")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry notes" })).not.toBeInTheDocument();
});
