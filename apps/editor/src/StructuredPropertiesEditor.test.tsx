import { render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "@mdbase-dev/connect";
import { useMemo, useState } from "react";
import { describe, expect, it } from "vitest";
import { LinkTargets } from "./collection-links";
import type { CreateLinkedRecord, PropertyLinks } from "./LinkPropertyEditor";
import type { LinkSuggestion } from "./links";
import type { LinkTarget } from "./model";
import type { LinkProperty } from "./record-links";
import { StructuredPropertiesEditor } from "./StructuredPropertiesEditor";

describe("structured property selection controls", () => {
  it("keeps undeclared typed properties quiet without discarding or locking their values", async () => {
    const user = userEvent.setup();
    render(<AdditionalPropertyHarness />);
    expect(screen.getByRole("textbox", { name: "title value" })).toBeVisible();
    expect(screen.getByText("Additional properties").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("spinbutton", { name: "mobileRevision value" })).not.toBeVisible();
    await user.clear(screen.getByRole("textbox", { name: "title value" }));
    await user.type(screen.getByRole("textbox", { name: "title value" }), "Changed");
    expect(JSON.parse(screen.getByTestId("additional-value").textContent ?? "{}")).toEqual({ title: "Changed", mobileRevision: 4 });
    await user.click(screen.getByText("Additional properties"));
    expect(screen.getByRole("spinbutton", { name: "mobileRevision value" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "mobileRevision value" })).toHaveValue(4);
    expect(screen.getByRole("combobox", { name: "mobileRevision property type" })).toBeEnabled();
  });

  it("keeps string tags editable as chips for nullable list schemas", () => {
    render(<StructuredPropertiesEditor value={{ tags: ["kept"] }}
      contract={{ properties: { tags: { type: ["array", "null"], items: { type: "string" } } }, required: [] }} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Add tag" })).toBeVisible();
    expect(screen.getByLabelText("tags value item 1")).toHaveValue("kept");
  });

  it("keeps free-form properties visible when no type groups them", () => {
    render(<StructuredPropertiesEditor value={{ custom: "Kept" }} contract={{ properties: {}, required: [] }} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "custom value" })).toBeVisible();
    expect(screen.queryByText("Additional properties")).not.toBeInTheDocument();
  });
  it("shows link properties as links, and finds a record of the property's type to add", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(<LinkPropertyHarness onOpen={(path) => opened.push(path)} />);

    // A written link is its record's title, and opens it.
    const author = screen.getByRole("group", { name: "author" });
    await user.click(await within(author).findByRole("button", { name: "Grace Hopper" }));
    expect(opened).toEqual(["People/grace.md"]);
    expect(within(author).queryByRole("combobox")).not.toBeInTheDocument();

    const reviewers = screen.getByRole("group", { name: "reviewers" });
    await user.click(within(reviewers).getByRole("button", { name: "Add a link to reviewers" }));
    const picker = within(reviewers).getByRole("combobox", { name: "Add a link to reviewers" });
    await user.type(picker, "a");
    const list = screen.getByRole("listbox", { name: "Add a link to reviewers" });
    // Only people: the project matches the text but not the property's type; Ada is linked already.
    expect(within(list).queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: /Ada Lovelace/ })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("option", { name: /Grace Hopper/ }));
    expect(saved().reviewers).toEqual(["[[People/ada]]", "[[People/grace]]"]);

    await user.click(await within(reviewers).findByRole("button", { name: "Remove Ada Lovelace from reviewers" }));
    expect(saved().reviewers).toEqual(["[[People/grace]]"]);
    await user.click(within(author).getByRole("button", { name: "Remove Grace Hopper from author" }));
    expect(saved().author).toBe("");
    expect(within(author).getByRole("combobox", { name: "author value" })).toBeVisible();
  });

  it("makes a record of the property's type from the typed name and links it", async () => {
    const user = userEvent.setup();
    const made: Array<[string | undefined, string]> = [];
    render(<LinkPropertyHarness initial={{ author: "", reviewers: [] }} onCreate={(type, title, creation) => {
      made.push([type, title]);
      creation.link({ path: `People/${title}.md`, title });
    }} />);

    const picker = within(screen.getByRole("group", { name: "author" })).getByRole("combobox", { name: "author value" });
    await user.type(picker, "Katherine Johnson");
    await user.click(screen.getByRole("option", { name: "New person “Katherine Johnson”" }));
    expect(made).toEqual([["person", "Katherine Johnson"]]);
    expect(saved().author).toBe("[Katherine Johnson](</People/Katherine Johnson.md>)");
    // The picker that made the link is gone: the keyboard stays with the property.
    await waitFor(() => expect(screen.getByRole("group", { name: "author" })).toContainElement(document.activeElement as HTMLElement));
  });

  it("leaves a value the link rule does not fit to be repaired as plain data", () => {
    const { container } = render(<LinkPropertyHarness initial={{ author: ["one", "two"], reviewers: "just text" }} />);
    expect(container.querySelector(".link-property")).not.toBeInTheDocument();
    // The ordinary repair for a value that does not match its schema takes over.
    expect(screen.getAllByText(/The existing value doesn't match type/)).toHaveLength(2);
  });
});

function saved(): JsonObject {
  return JSON.parse(screen.getByTestId("link-property-value").textContent ?? "{}") as JsonObject;
}

function AdditionalPropertyHarness() {
  const [value, setValue] = useState<JsonObject>({ title: "Original", mobileRevision: 4 });
  return <>
    <StructuredPropertiesEditor value={value} contract={{ required: [], properties: { title: { type: "string" } } }} groupUndeclared onChange={setValue} />
    <output data-testid="additional-value">{JSON.stringify(value)}</output>
  </>;
}

function LinkPropertyHarness({ initial = { author: "[[People/grace]]", reviewers: ["[[People/ada]]"] }, onOpen, onCreate }: {
  initial?: JsonObject;
  onOpen?: (path: string) => void;
  onCreate?: CreateLinkedRecord;
}) {
  const [value, setValue] = useState<JsonObject>(initial);
  const targets = useMemo(() => new LinkTargets({
    resolveLinks: async (_from, raws) => raws.map((raw): LinkTarget => {
      const path = `${/^\[\[([^\]|]+)/u.exec(raw)?.[1] ?? ""}.md`;
      return suggestions.some((suggestion) => suggestion.path === path) ? { kind: "note", path } : { kind: "missing" };
    })
  }, "Books/compilers.md"), []);
  const links = useMemo<PropertyLinks>(() => ({
    properties: new Map<string, LinkProperty>([
      ["author", { field: "author", many: false, targetTypes: ["person"], format: "markdown" }],
      ["reviewers", { field: "reviewers", many: true, targetTypes: ["person"], format: "wikilink" }]
    ]),
    suggestions,
    types: [],
    targets,
    currentPath: "Books/compilers.md",
    ...(onOpen ? { onOpen } : {}),
    ...(onCreate ? { onCreate } : {})
  }), [targets, onOpen, onCreate]);
  return <>
    <StructuredPropertiesEditor value={value} contract={linkContract} links={links} allowAdd={false} onChange={setValue} />
    <output data-testid="link-property-value">{JSON.stringify(value)}</output>
  </>;
}

const suggestions: LinkSuggestion[] = [
  { path: "People/ada.md", title: "Ada Lovelace", types: ["person"] },
  { path: "People/grace.md", title: "Grace Hopper", types: ["person"] },
  { path: "Projects/alpha.md", title: "Alpha", types: ["project"] }
];

const linkContract = {
  required: [],
  properties: {
    author: { type: "string" },
    reviewers: { type: "array", items: { type: "string" } }
  }
};
