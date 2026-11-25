// @vitest-environment jsdom
import { i18n } from "@mdbase-dev/ui/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "./host";
import type { RecordDocument, Shown } from "./model";
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
  types: [{ name: "task", schema: { properties: { title: { type: "string" }, estimate: { type: "number" }, owner: { type: "string" } } } }]
};

function host(show: Host["show"], operations = describeResult.operations) {
  return { show, read: vi.fn(async () => ({ ...describeResult, operations })), openLink: vi.fn(), tell: vi.fn<Host["tell"]>() } satisfies Host;
}

async function card(view: Host) {
  render(<I18nProvider i18n={i18n}><RecordCard host={view} connectionId={connection} record={record} renamedFrom={undefined} onOpen={vi.fn()} /></I18nProvider>);
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

const saved = (frontmatter: Record<string, unknown>, revision: string): Shown => ({ kind: "record", renamedFrom: undefined, record: { ...record, revision, frontmatter } });

describe("a record card", () => {
  it("saves each change against the revision the previous save returned, and removes a cleared value", async () => {
    const show = vi.fn<Host["show"]>()
      .mockResolvedValueOnce(saved({ ...record.frontmatter, owner: "Alex" }, "r2"))
      .mockResolvedValueOnce(saved({ title: "Renew passport", owner: "Alex" }, "r3"));
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
    await card(host(vi.fn(), ["describe", "read"]));
    expect(screen.queryByLabelText("owner")).toBeNull();
    expect(screen.getByText("Sam")).toBeTruthy();
  });
});
