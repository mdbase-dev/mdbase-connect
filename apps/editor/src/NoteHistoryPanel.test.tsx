import { render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import { mdbaseError } from "@mdbase-dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteHistoryPanel } from "./NoteHistoryPanel";
import type { NoteHistory, NoteVersion } from "./model";

const ME = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const DEVICE = "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467";
const now = new Date(2026, 10, 17, 12).getTime();

function version(seq: number, minutesAgo: number, overrides: Partial<NoteVersion> = {}): NoteVersion {
  return {
    seq, time: now - minutesAgo * 60_000, kind: "edited", path: "notes/a.md", source: "api",
    author: { account: ME, device: DEVICE, grant: DEVICE }, deviceKind: "app_runtime", app: "dev.mdbase.editor", ...overrides
  };
}

function gateway(pages: NoteHistory[] | Error, texts: Record<number, string | Error> = {}) {
  return {
    list: vi.fn(async (_path: string, { before }: { before?: number } = {}) => {
      if (pages instanceof Error) throw pages;
      return pages.find((page) => before === undefined ? page === pages[0] : page.versions[0]!.seq < before)!;
    }),
    version: vi.fn(async (_path: string, seq: number) => {
      const text = texts[seq];
      if (text instanceof Error) throw text;
      if (text === undefined) throw new Error(`no text for ${seq}`);
      return text;
    }),
    peopleDirectory: vi.fn(async () => ({ account: { accountId: ME } }) as unknown as import("./connect-types").PeopleDirectory)
  };
}

const panel = (history: ReturnType<typeof gateway>, props: Partial<Parameters<typeof NoteHistoryPanel>[0]> = {}) =>
  render(<NoteHistoryPanel history={history} gateway={history} path="notes/a.md" title="A" current={"# A\n\nNow\n"} onAuthorize={vi.fn()} onClose={vi.fn()} {...props} />);

describe("note history", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now }); });
  afterEach(() => { vi.useRealTimers(); });

  it("lists versions by day as runs of saves, with whose they were", async () => {
    const history = gateway([{ versions: [version(9, 1), version(8, 4), version(7, 30, { kind: "created" })], from: 1 }]);
    panel(history);
    const today = await screen.findByRole("region", { name: "Today" });
    const rows = within(today).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("You, in mdbase editor");
    expect(rows[0]).toHaveTextContent("2 saves");
    expect(rows[1]).toHaveTextContent("Created");
    expect(history.list).toHaveBeenCalledWith("notes/a.md", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // History back to the note's creation: nothing more to explain.
    expect(screen.queryByText(/no longer kept/)).not.toBeInTheDocument();
  });

  it("pages to older versions, then says where the kept history ends", async () => {
    const user = userEvent.setup();
    const history = gateway([
      { versions: [version(9, 1)], from: 9, next: 9 },
      { versions: [version(5, 90)], from: 3, fromTime: now - 120 * 60_000 }
    ]);
    panel(history);
    await user.click(await screen.findByRole("button", { name: "Show older versions" }));
    expect(history.list).toHaveBeenLastCalledWith("notes/a.md", expect.objectContaining({ before: 9 }));
    expect(await screen.findByText(/Earlier versions are no longer kept\. History goes back to/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /mdbase editor/ })).toHaveLength(2);
  });

  it("shows a version as a read-only diff against the note now", async () => {
    const user = userEvent.setup();
    const history = gateway([{ versions: [version(9, 1), version(4, 60, { kind: "created" })], from: 1 }], { 4: "# A\n\nThen\n" });
    panel(history);
    await user.click(await screen.findByRole("button", { name: /Created/ }));
    const diff = await screen.findByRole("table", { name: "Differences from the note now" });
    expect(within(diff).getByText("Then")).toBeInTheDocument();
    expect(within(diff).getByText("Now")).toBeInTheDocument();
    // A note that can't be edited offers no restore.
    expect(screen.queryByRole("button", { name: "Restore this version" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All versions" }));
    expect(await screen.findByRole("region", { name: "Today" })).toBeInTheDocument();
  });

  it("restores a version only after confirming, then reloads the history", async () => {
    const user = userEvent.setup();
    const restore = vi.fn(async () => true);
    const history = gateway([{ versions: [version(9, 1), version(4, 60, { kind: "created" })], from: 1 }], { 4: "# A\n\nThen\n" });
    panel(history, { onRestore: restore });
    await user.click(await screen.findByRole("button", { name: /Created/ }));
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    const confirm = await screen.findByRole("dialog", { name: "Restore this version?" });
    expect(within(confirm).getByText("+1 line added")).toBeInTheDocument();
    expect(within(confirm).getByText("−1 line removed")).toBeInTheDocument();
    const peek = within(confirm).getByRole("region", { name: "Summary of changes" });
    expect(within(peek).getByText("Then")).toBeInTheDocument();
    expect(within(peek).getByText("Now")).toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Restore" }));
    expect(restore).toHaveBeenCalledWith("# A\n\nThen\n");
    await waitFor(() => expect(history.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("region", { name: "Today" })).toBeInTheDocument();
  });

  it("says when a version matches the note now, and offers nothing to restore", async () => {
    const user = userEvent.setup();
    const history = gateway([{ versions: [version(9, 1)], from: 1 }], { 9: "# A\n\nNow\n" });
    panel(history, { onRestore: vi.fn() });
    await user.click(await screen.findByRole("button", { name: /mdbase editor/ }));
    expect(await screen.findByText("This version matches the note as it is now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore this version" })).not.toBeInTheDocument();
  });

  it("explains a version that's no longer kept", async () => {
    const user = userEvent.setup();
    const history = gateway([{ versions: [version(9, 1)], from: 1 }], { 9: mdbaseError("not_found", "compacted", "version_compacted") });
    panel(history);
    await user.click(await screen.findByRole("button", { name: /mdbase editor/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This version is no longer kept.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("lists again from the newest version when the replica no longer knows a listed one", async () => {
    const user = userEvent.setup();
    const history = gateway([{ versions: [version(9, 1)], from: 1 }],
      { 9: mdbaseError("invalid_request", "index rebuilt", "history_cursor_stale") });
    panel(history);
    await user.click(await screen.findByRole("button", { name: /mdbase editor/ }));
    await waitFor(() => expect(history.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("region", { name: "Today" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains when the collection serves no history", async () => {
    panel(gateway(mdbaseError("upgrade_required", "no history", "history_unsupported")));
    expect(await screen.findByText("History isn’t available here")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("asks for access when the grant doesn't include history", async () => {
    const user = userEvent.setup();
    const authorize = vi.fn();
    panel(gateway(mdbaseError("forbidden", "history.read", "capability_missing")), { onAuthorize: authorize });
    await user.click(await screen.findByRole("button", { name: "Update access" }));
    expect(authorize).toHaveBeenCalled();
  });

  it("retries a history read that failed", async () => {
    const user = userEvent.setup();
    const history = gateway([{ versions: [version(9, 1)], from: 1 }]);
    history.list.mockRejectedValueOnce(mdbaseError("unavailable", "log read failed", "history_offline"));
    panel(history);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Today" })).toBeInTheDocument();
  });

  it("tells versions apart by app and device without the account", async () => {
    const history = gateway([{ versions: [version(9, 1, { app: undefined, deviceKind: "desktop" })], from: 1 }]);
    history.peopleDirectory.mockRejectedValue(new Error("declined"));
    panel(history);
    expect(await screen.findByRole("button", { name: /On desktop/ })).toBeInTheDocument();
  });
});
