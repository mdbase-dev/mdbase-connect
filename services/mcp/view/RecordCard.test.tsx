// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { i18n } from "@mdbase-dev/ui/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "./host";
import type { Changes, RecordDocument, Shown } from "./model";
import { RecordCard } from "./RecordCard";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});
afterEach(cleanup);

// Descriptions are kept per connection for the life of the view, so each test has its own.
let connection = "";
let tests = 0;
beforeEach(() => { connection = `0191aaaa-0000-7000-8000-${String(++tests).padStart(12, "0")}`; });
const record: RecordDocument = {
  path: "tasks/renew-passport.md", revision: "r1", types: ["task"], name: "renew-passport", body: "",
  frontmatter: { title: "Renew passport", estimate: 2, owner: "Sam" }
};
const describeResult = {
  display_name: "Personal tasks",
  operations: ["describe", "read", "update"],
  types: [{ name: "task", schema: { required: ["status"], properties: { title: { type: "string" }, status: { type: "string" }, estimate: { type: "number" }, owner: { type: "string" } } } }]
};

function host(show: Host["show"], operations = describeResult.operations) {
  return { show, read: vi.fn(async () => ({ ...describeResult, operations })), openLink: vi.fn(), tell: vi.fn<Host["tell"]>(), display: vi.fn() } satisfies Host;
}

async function card(view: Host, shown: RecordDocument = record, options: { open?: boolean; changes?: Changes } = {}) {
  render(<I18nProvider i18n={i18n}><RecordCard
    host={view} connectionId={connection} record={shown} renamedFrom={undefined} onOpen={vi.fn()}
    open={options.open ?? false} full={false} changes={options.changes}
  /></I18nProvider>);
  await act(async () => undefined);
}

/** Types into a property's field as a person does, then presses Enter to commit it. */
async function commit(name: string, text: string) {
  const field = screen.getByLabelText(name) as HTMLInputElement;
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await act(async () => undefined);
}

const saved = (change: Partial<RecordDocument>): Shown => ({ kind: "record", renamedFrom: undefined, record: { ...record, ...change } });

describe("a record card", () => {
  it("saves each change against the revision the previous save returned, and removes a cleared value", async () => {
    const show = vi.fn<Host["show"]>()
      .mockResolvedValueOnce(saved({ frontmatter: { ...record.frontmatter, owner: "Alex" }, revision: "r2" }))
      .mockResolvedValueOnce(saved({ frontmatter: { title: "Renew passport", owner: "Alex" }, revision: "r3" }));
    const view = host(show);
    await card(view);
    await commit("owner", "Alex");
    await commit("estimate", "");
    expect(show.mock.calls).toEqual([
      ["update_record", { connection_id: connection, path: record.path, if_revision: "r1", patch: { owner: "Alex" } }],
      ["update_record", { connection_id: connection, path: record.path, if_revision: "r2", unset: ["estimate"] }]
    ]);
    expect(view.tell).toHaveBeenLastCalledWith('In the mdbase view the user removed "estimate" from tasks/renew-passport.md; its revision is now r3.');
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("puts a refused change back and says why", async () => {
    const view = host(vi.fn(async (): Promise<Shown> => ({ kind: "error", code: "revision_conflict", message: "The record changed since you read it.", link: undefined })));
    await card(view);
    await commit("owner", "Alex");
    expect(screen.getByRole("alert").textContent).toContain("The record changed since you read it.");
    expect((screen.getByLabelText("owner") as HTMLInputElement).value).toBe("Sam");
    expect(view.tell).not.toHaveBeenCalled();
  });

  it("only shows the properties of a connection not approved to update records", async () => {
    await card(host(vi.fn(), ["describe", "read"]), { ...record, body: "Book an appointment." });
    expect(screen.queryByLabelText("owner")).toBeNull();
    expect(screen.getByText("Sam")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
  });

  it("starts folded to what the model changed and what the type requires, and unfolds to the rest and the body", async () => {
    const full = { ...record, body: "Book an appointment.", frontmatter: { title: "Renew passport", status: "open", estimate: 2, owner: "Sam", place: "Post office", tags: ["admin"] } };
    await card(host(vi.fn()), full, { changes: { set: ["owner"], removed: ["due"], body: true } });
    const fields = () => [...document.querySelectorAll<HTMLElement>(".mdbase-property[data-field]")].map((row) => row.dataset.field);
    expect(fields()).toEqual(["status", "estimate", "owner", "place"]);
    expect(document.querySelector(".view-body")).toBeNull();
    expect(document.querySelector('[data-field="owner"]')!.hasAttribute("data-changed")).toBe(true);
    expect(document.querySelector('[data-field="status"]')!.hasAttribute("data-changed")).toBe(false);
    expect(document.querySelector(".view-changes")!.textContent).toBe("Changed ownerRemoved dueChanged the text");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(fields()).toEqual(["status", "estimate", "owner", "place", "tags"]);
    expect(document.querySelector(".view-body")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("saves an edited body as a whole, keeping the edit open while it is refused", async () => {
    const show = vi.fn<Host["show"]>()
      .mockResolvedValueOnce({ kind: "error", code: "revision_conflict", message: "The record changed since you read it.", link: undefined })
      .mockResolvedValueOnce(saved({ body: "Book an appointment today.", revision: "r2" }));
    const view = host(show);
    await card(view, { ...record, body: "Book an appointment." }, { open: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    const body = EditorView.findFromDOM(document.querySelector<HTMLElement>(".view-body.is-editing")!)!;
    act(() => body.dispatch({ changes: { from: body.state.doc.length - 1, insert: " today" } }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("alert").textContent).toContain("The record changed since you read it.");
    expect(document.querySelector(".view-body.is-editing")).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(show.mock.calls.map(([, args]) => args)).toEqual([
      { connection_id: connection, path: record.path, if_revision: "r1", body: "Book an appointment today." },
      { connection_id: connection, path: record.path, if_revision: "r1", body: "Book an appointment today." }
    ]);
    expect(document.querySelector(".view-body.is-editing")).toBeNull();
    expect(view.tell).toHaveBeenCalledWith("In the mdbase view the user edited the body of tasks/renew-passport.md; its revision is now r2.");
  });

  it("saves a ticked task box as the body with the box ticked", async () => {
    const show = vi.fn<Host["show"]>().mockResolvedValueOnce(saved({ body: "- [x] Book an appointment\n- [ ] Take photos", revision: "r2" }));
    const view = host(show);
    await card(view, { ...record, body: "- [ ] Book an appointment\n- [ ] Take photos" }, { open: true });
    const box = document.querySelector<HTMLElement>(".cm-lp-task")!;
    await act(async () => fireEvent.mouseDown(box, { button: 0 }));
    expect(show).toHaveBeenCalledWith("update_record", { connection_id: connection, path: record.path, if_revision: "r1", body: "- [x] Book an appointment\n- [ ] Take photos" });
    expect(view.tell).toHaveBeenCalledWith('In the mdbase view the user ticked the task "Book an appointment" in tasks/renew-passport.md; its revision is now r2.');
  });
});
