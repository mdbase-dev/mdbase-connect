// @vitest-environment jsdom
import { i18n } from "@mdbase-dev/ui/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "./host";
import type { Json, Records, Row, Shown } from "./model";
import { NewRecord } from "./NewRecord";
import { RecordsTable } from "./RecordsTable";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});
afterEach(cleanup);

let connection = "";
let tests = 0;
beforeEach(() => { connection = `0191bbbb-0000-7000-8000-${String(++tests).padStart(12, "0")}`; });

const row = (path: string, revision: string, cells: Json): Row => ({ path, revision, name: path.slice(6, -3), types: ["task"], cells, frontmatter: { title: path, ...cells } });
const results: Records = {
  kind: "records",
  rows: [row("tasks/a.md", "r1", { owner: "Sam", done: false, overdue: true }), row("tasks/b.md", "r5", { owner: "Alex", done: true, overdue: false })],
  columns: [{ key: "owner", label: "owner", field: true }, { key: "done", label: "done", field: true }, { key: "overdue", label: "Overdue", field: false }],
  cursor: undefined,
  total: undefined
};
const describeResult = {
  display_name: "Personal tasks",
  operations: ["describe", "read", "update", "create"],
  types: [{ name: "task", schema: { required: ["status"], properties: { title: { type: "string" }, status: { type: "string" }, owner: { type: "string" }, done: { type: "boolean" } } } }]
};

function host(show: Host["show"], operations = describeResult.operations) {
  return { show, read: vi.fn(async () => ({ ...describeResult, operations })), openLink: vi.fn(), tell: vi.fn<Host["tell"]>(), display: vi.fn() } satisfies Host;
}

function Table({ view, args, onSort = vi.fn(async () => undefined), onCreate = vi.fn() }: { view: Host; args: Json; onSort?: (field: string) => Promise<void>; onCreate?: (type: string) => void }) {
  const [shown, setShown] = useState(results);
  return <I18nProvider i18n={i18n}><RecordsTable
    host={view} connectionId={connection} args={args} shown={shown}
    onOpen={vi.fn()} onMore={vi.fn(async () => undefined)} onSort={onSort} onCreate={onCreate}
    onRow={(changed) => setShown((current) => ({ ...current, rows: current.rows.map((each) => each.path === changed.path ? changed : each) }))}
  /></I18nProvider>;
}

/** Types into a field as a person does, then presses Enter to commit it. */
async function commit(field: HTMLInputElement, text: string) {
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
}

const savedRow = (path: string, revision: string, frontmatter: Json): Shown => ({ kind: "record", renamedFrom: undefined, record: { path, revision, types: ["task"], name: path, body: "", frontmatter } });

describe("query results", () => {
  it("orders the query by a field column or the name, and says which way it is ordered", async () => {
    const onSort = vi.fn(async () => undefined);
    render(<Table view={host(vi.fn())} args={{ types: ["task"], order_by: [{ field: "owner", direction: "desc" }] }} onSort={onSort} />);
    await act(async () => undefined);
    expect(screen.getByRole("columnheader", { name: /owner/u }).getAttribute("aria-sort")).toBe("descending");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "done" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Name" })));
    expect(onSort.mock.calls).toEqual([["done"], ["file.name"]]);
    // A computed column is not a field: it can be neither sorted by nor changed.
    expect(screen.queryByRole("button", { name: "Overdue" })).toBeNull();
  });

  it("changes a value in place against the row's latest revision, and tells the model", async () => {
    const show = vi.fn<Host["show"]>()
      .mockResolvedValueOnce(savedRow("tasks/a.md", "r2", { title: "tasks/a.md", owner: "Kim", done: false }))
      .mockResolvedValueOnce(savedRow("tasks/a.md", "r3", { title: "tasks/a.md", owner: "Kim", done: true }));
    const view = host(show);
    render(<Table view={view} args={{ types: ["task"] }} />);
    await act(async () => undefined);
    await commit(screen.getAllByLabelText("owner")[0] as HTMLInputElement, "Kim");
    await act(async () => fireEvent.click(screen.getAllByRole("switch", { name: "done" })[0]!));
    expect(show.mock.calls.map(([, args]) => args)).toEqual([
      { connection_id: connection, path: "tasks/a.md", if_revision: "r1", patch: { owner: "Kim" } },
      { connection_id: connection, path: "tasks/a.md", if_revision: "r2", patch: { done: true } }
    ]);
    expect((screen.getAllByLabelText("owner")[0] as HTMLInputElement).value).toBe("Kim");
    expect(screen.getAllByRole("switch", { name: "done" })[0]!.getAttribute("aria-checked")).toBe("true");
    expect(view.tell).toHaveBeenLastCalledWith('In the mdbase view the user set "done" on tasks/a.md to true; its revision is now r3.');
  });

  it("puts back a value whose change was refused and says why", async () => {
    render(<Table view={host(vi.fn(async (): Promise<Shown> => ({ kind: "error", code: "revision_conflict", message: "The record changed since you read it.", link: undefined })))} args={{}} />);
    await act(async () => undefined);
    await act(async () => fireEvent.click(screen.getAllByRole("switch", { name: "done" })[1]!));
    expect(screen.getByRole("alert").textContent).toBe("The record changed since you read it.");
    expect(screen.getAllByRole("switch", { name: "done" })[1]!.getAttribute("aria-checked")).toBe("true");
  });

  it("offers a new record of the one type the results show, when the connection may create records", async () => {
    const onCreate = vi.fn();
    render(<Table view={host(vi.fn())} args={{}} onCreate={onCreate} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(onCreate).toHaveBeenCalledWith("task");
    cleanup();
    connection = `${connection.slice(0, -1)}f`;
    render(<Table view={host(vi.fn(), ["describe", "read", "update"])} args={{}} />);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryAllByRole("switch", { name: "done" })).toHaveLength(2);
  });
});

describe("a new record", () => {
  it("is made with its title and properties as one create_record of its type", async () => {
    const show = vi.fn<Host["show"]>().mockResolvedValueOnce(savedRow("tasks/call-the-bank.md", "r1", { title: "Call the bank", status: "open" }));
    const view = host(show);
    const onCreated = vi.fn();
    render(<I18nProvider i18n={i18n}><NewRecord host={view} connectionId={connection} type="task" onCreated={onCreated} onCancel={vi.fn()} /></I18nProvider>);
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: " Call the bank " } });
    await commit(screen.getByLabelText("status"), "open");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
    expect(show).toHaveBeenCalledWith("create_record", { connection_id: connection, type: "task", frontmatter: { status: "open", title: "Call the bank" } });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ path: "tasks/call-the-bank.md" }));
    expect(view.tell).toHaveBeenCalledWith("In the mdbase view the user created tasks/call-the-bank.md, a task; its revision is r1.");
  });
});
