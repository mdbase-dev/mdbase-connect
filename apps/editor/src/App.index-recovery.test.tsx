import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
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

it("retries the failed inventory and starts full-text indexing only after all notes load", async () => {
  class InterruptedGateway extends DemoCollectionGateway {
    fail = true;
    async list(options: NoteIndexRequest = {}) {
      if (!this.fail) return super.list(options);
      const result = await super.list({ signal: options.signal });
      options.onProgress?.({ notes: result.notes.slice(0, 400), total: result.notes.length,
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
