import { render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import { PropertyList } from "@mdbase-dev/ui/properties";
import { useMemo, useState } from "react";
import { describe, expect, it } from "vitest";
import { LinkTargets } from "./collection-links";
import type { JsonObject } from "./connect-types";
import type { CreateLinkedRecord, PropertyLinks } from "./LinkPropertyEditor";
import type { LinkSuggestion } from "./links";
import type { LinkTarget } from "./model";
import { propertyInfos } from "./property-info";
import { usePropertyRecords } from "./property-records";
import type { LinkProperty } from "./record-links";

describe("a record's link fields in the property list", () => {
  it("names a written link by its record, opens it, and finds a record of the field's type to add", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(<Harness onOpen={(path) => opened.push(path)} />);

    const author = row("author");
    await user.click(await within(author).findByRole("button", { name: "Grace Hopper" }));
    expect(opened).toEqual(["People/grace.md"]);
    // One link is all the field holds: there is nothing to add to it.
    expect(within(author).queryByRole("button", { name: "Link a record in author" })).toBeNull();

    const reviewers = row("reviewers");
    await user.click(within(reviewers).getByRole("button", { name: "Link a record in reviewers" }));
    await user.keyboard("a");
    // Only people: the project matches the text but not the field's type; Ada is linked already.
    await waitFor(() => expect(screen.getByRole("option", { name: /Grace Hopper/ })).toBeVisible());
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).toBeNull();
    await user.keyboard("{Enter}");
    expect(saved().reviewers).toEqual(["[[People/ada]]", "[[People/grace]]"]);

    await user.click(await within(row("reviewers")).findByRole("button", { name: "Remove Ada Lovelace" }));
    expect(saved().reviewers).toEqual(["[[People/grace]]"]);
  });

  it("makes a record of the field's type from the typed name, and links it as the rule writes links", async () => {
    const user = userEvent.setup();
    const made: Array<[string | undefined, string]> = [];
    render(<Harness initial={{ reviewers: [] }} onCreate={(type, title, creation) => {
      made.push([type, title]);
      creation.link({ path: `People/${title}.md`, title });
    }} />);

    // Fields that hold nothing stay out of the way until they are asked for.
    await user.click(screen.getByRole("button", { name: "2 empty" }));
    await user.click(within(row("author")).getByRole("button", { name: "Link a record in author" }));
    await user.keyboard("Katherine Johnson");
    await user.click(await screen.findByRole("option", { name: "New person “Katherine Johnson”" }));
    expect(made).toEqual([["person", "Katherine Johnson"]]);
    expect(saved().author).toBe("[Katherine Johnson](</People/Katherine Johnson.md>)");
  });

  it("marks a link that leads nowhere", async () => {
    render(<Harness initial={{ author: "[[People/nobody]]", reviewers: [] }} />);
    await waitFor(() => expect(row("author").querySelector("[data-missing]")).not.toBeNull());
  });
});

function row(field: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-field="${field}"]`)!;
}

function saved(): JsonObject {
  return JSON.parse(screen.getByTestId("saved").textContent ?? "{}") as JsonObject;
}

function Harness({ initial = { author: "[[People/grace]]", reviewers: ["[[People/ada]]"] }, onOpen, onCreate }: {
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
    properties: rules,
    suggestions,
    types: [],
    targets,
    currentPath: "Books/compilers.md",
    ...(onOpen ? { onOpen } : {}),
    ...(onCreate ? { onCreate } : {})
  }), [targets, onOpen, onCreate]);
  const records = usePropertyRecords(links, value);
  const declared = useMemo(() => propertyInfos(schema, [], rules), []);
  return <>
    <PropertyList values={value} declared={declared} records={records}
      onChange={(name, next) => setValue((held) => ({ ...held, [name]: next }) as JsonObject)} />
    <output data-testid="saved">{JSON.stringify(value)}</output>
  </>;
}

const rules = new Map<string, LinkProperty>([
  ["author", { field: "author", many: false, targetTypes: ["person"], format: "markdown" }],
  ["reviewers", { field: "reviewers", many: true, targetTypes: ["person"], format: "wikilink" }]
]);

const schema = {
  author: { type: "string" },
  reviewers: { type: "array", items: { type: "string" } }
};

const suggestions: LinkSuggestion[] = [
  { path: "People/ada.md", title: "Ada Lovelace", types: ["person"] },
  { path: "People/grace.md", title: "Grace Hopper", types: ["person"] },
  { path: "Projects/alpha.md", title: "Alpha", types: ["project"] }
];
