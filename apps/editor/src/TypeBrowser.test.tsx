import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionContractDescriptor, CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ContractCatalog } from "./contract-catalog";
import type { NoteSummary, TypeDocument } from "./model";
import { TypeInspector, TypePackBrowser } from "./TypeBrowser";
import { NEW_TYPE_SOURCE } from "./type-constants";
import { readVisualType } from "./type-schema";

describe("recursive type builder", () => {
  it("summarises secondary type settings behind quiet disclosures", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={collectionSource} contracts={[personContract]} />);

    const membership = screen.getByRole("heading", { name: "Type membership" }).closest<HTMLDetailsElement>("details")!;
    const behaviour = screen.getByRole("heading", { name: "Collection behaviour" }).closest<HTMLDetailsElement>("details")!;
    const contracts = screen.getByRole("heading", { name: "Works with applications" }).closest<HTMLDetailsElement>("details")!;

    expect(membership).not.toHaveAttribute("open");
    expect(behaviour).not.toHaveAttribute("open");
    expect(contracts).not.toHaveAttribute("open");
    expect(within(membership).getByText("Explicit declarations only")).toBeInTheDocument();
    expect(within(behaviour).getByText(/Display · 1 default · 1 link · 1 unique rule · Path policy/)).toBeInTheDocument();
    expect(within(contracts).getByText("No connections")).toBeInTheDocument();
    expect(membership).not.toContainElement(screen.getByRole("heading", { name: "Fields" }));

    await user.click(within(behaviour).getByText("Collection behaviour").closest("summary")!);
    expect(behaviour).toHaveAttribute("open");
  });

  it("adds and edits nested object fields through the design view", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    expect(screen.getByRole("button", { name: "Remove title field" })).toHaveClass(
      "icon-button",
      "inline-remove-button",
      "remove-type-field"
    );
    await user.click(screen.getByRole("button", { name: "Expand profile field" }));
    expect(screen.getByDisplayValue("display_name")).toBeInTheDocument();
    const nestedGroup = screen.getByText("Nested fields").closest<HTMLElement>(".nested-field-group")!;
    await user.click(within(nestedGroup).getByRole("button", { name: "Add nested field" }));
    const added = screen.getByDisplayValue("field");
    await user.clear(added);
    await user.type(added, "timezone");
    await user.tab();
    const timezoneRow = screen.getByDisplayValue("timezone").closest<HTMLElement>(".visual-field-row")!;
    await user.click(within(timezoneRow).getByRole("checkbox", { name: "Required" }));

    const source = screen.getByTestId("source").textContent ?? "";
    expect(source).toContain("timezone:");
    expect(source).toContain("required:");
    expect(source).toContain("- timezone");
  });

  it("keeps a single field branch active while preserving its ancestors", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    const category = screen.getByRole("button", { name: "Expand category field" });
    await user.click(category);
    expect(category).toHaveAttribute("aria-expanded", "true");

    const profile = screen.getByRole("button", { name: "Expand profile field" });
    await user.click(profile);
    expect(category).toHaveAttribute("aria-expanded", "false");
    expect(profile).toHaveAttribute("aria-expanded", "true");

    const displayName = screen.getByRole("button", { name: "Expand profile.display_name field" });
    await user.click(displayName);
    expect(profile).toHaveAttribute("aria-expanded", "true");
    expect(displayName).toHaveAttribute("aria-expanded", "true");
  });

  it("requires inline confirmation before replacing nested structure", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    await user.selectOptions(screen.getByRole("combobox", { name: "profile field kind" }), "string");
    const warning = screen.getByRole("alert");
    expect(within(warning).getByText(/removes nested fields/)).toBeInTheDocument();
    expect(screen.getByTestId("source")).toHaveTextContent("display_name:");

    await user.click(within(warning).getByRole("button", { name: "Convert field" }));
    expect(screen.getByTestId("source")).not.toHaveTextContent("display_name:");
    expect(screen.getByTestId("source")).toHaveTextContent(/profile:\s+type: string/);
  });

  it("keeps multiple required fields selected", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    const categoryRow = screen.getByDisplayValue("category").closest<HTMLElement>(".visual-field-row")!;
    const profileRow = screen.getByDisplayValue("profile").closest<HTMLElement>(".visual-field-row")!;
    await user.click(within(categoryRow).getByRole("checkbox", { name: "Required" }));
    await user.click(within(profileRow).getByRole("checkbox", { name: "Required" }));

    const required = readVisualType(screen.getByTestId("source").textContent ?? "").fields
      .filter((field) => field.required)
      .map((field) => field.name);
    expect(required).toEqual(["title", "category", "profile"]);
  });

  it("edits choices as distinct line items", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    await user.click(screen.getByRole("button", { name: "Expand category field" }));
    const choices = screen.getByText("Choices").closest<HTMLElement>(".string-list-editor")!;
    expect(within(choices).getByLabelText("category choice 1")).toHaveValue("personal");
    expect(within(choices).getByLabelText("category choice 2")).toHaveValue("work");

    await user.click(within(choices).getByRole("button", { name: "Add choice" }));
    await user.type(within(choices).getByLabelText("category choice 3"), "archive");
    await user.tab();

    expect(readVisualType(screen.getByTestId("source").textContent ?? "").fields
      .find((field) => field.name === "category")?.constraints.choices).toEqual(["personal", "work", "archive"]);
  });

  it("accepts spaces in field descriptions", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness />);

    await user.click(screen.getByRole("button", { name: "Expand category field" }));
    const description = screen.getByRole("textbox", { name: "category description" });
    await user.type(description, "These are the tags for the notes.");

    expect(description).toHaveValue("These are the tags for the notes.");
    expect(readVisualType(screen.getByTestId("source").textContent ?? "").fields
      .find((field) => field.name === "category")?.description).toBe("These are the tags for the notes.");
  });

  it("explains explicit and inferred matching while routing complex rules to YAML", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={advancedMatchSource} />);
    expect(screen.getByText("Explicit assignment")).toBeInTheDocument();
    expect(screen.getByText("Automatic matching")).toBeInTheDocument();
    expect(screen.getByText("Path matches any")).toBeInTheDocument();
    expect(screen.getByText("Frontmatter contains all")).toBeInTheDocument();
    expect(screen.getByDisplayValue("People/**/*.md")).toBeInTheDocument();
    expect(screen.getByLabelText("Required match field 1")).toHaveValue("profile");
    expect(screen.getByText(/Structured frontmatter conditions/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open YAML" }));
    expect(screen.getByRole("textbox", { name: "person type YAML" })).toBeInTheDocument();
  });

  it("previews membership changes as visual rules are edited", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness notes={[
      noteSummary("Inbox/explicit.md", { type: "person" }, ["person"]),
      noteSummary("People/new.md", { title: "New" }, []),
      noteSummary("People/other.md", { type: "organisation" }, ["organisation"])
    ]} />);

    await user.click(screen.getByText("Type membership").closest("summary")!);
    expect(screen.getByText("1 note with these rules")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add path pattern" }));
    await user.type(screen.getByLabelText("Path pattern 1"), "People/**/*.md");
    await user.tab();

    expect(screen.getByText("2 notes with these rules")).toBeInTheDocument();
    expect(screen.getByText(/1 gain this type · 0 lose it/)).toBeInTheDocument();
    await user.click(screen.getByText("Show affected notes"));
    expect(screen.getByText("People/new.md")).toBeInTheDocument();
    expect(screen.queryByText("People/other.md")).not.toBeInTheDocument();
  });

  it("edits collection display, defaults, links, uniqueness, and path policy", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={collectionSource} />);

    expect(screen.getByRole("heading", { name: "Collection behaviour" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Name field" }), "category");
    const icon = screen.getByRole("combobox", { name: "Display icon" });
    await user.clear(icon);
    await user.type(icon, "notebook");
    await user.click(within(screen.getByRole("listbox", { name: "Phosphor icons" })).getByRole("option", { name: "notebook" }));

    const defaultValue = screen.getByRole("textbox", { name: "Default value for category" });
    await user.clear(defaultValue);
    await user.type(defaultValue, "A quiet default");

    await user.selectOptions(screen.getByRole("combobox", { name: "category link format" }), "markdown");
    await user.click(screen.getByRole("checkbox", { name: "Require an existing target" }));
    const targetType = screen.getByRole("combobox", { name: "category target type 1" });
    await user.clear(targetType);
    const targetSuggestions = screen.getByRole("listbox", { name: "category target type suggestions" });
    expect(targetSuggestions).toHaveClass("combobox-popover");
    await user.click(within(targetSuggestions).getByRole("option", { name: "any" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "title uniqueness scope" }), "path_glob");
    await user.type(screen.getByRole("textbox", { name: "title uniqueness path pattern" }), "People/**/*.md");

    const pathPattern = screen.getByRole("textbox", { name: /^Path pattern$/ });
    await user.clear(pathPattern);
    await user.type(pathPattern, "People/title.md");

    const definition = readVisualType(screen.getByTestId("source").textContent ?? "");
    expect(definition.collection).toMatchObject({
      display: { nameField: "category", icon: "notebook" },
      readDefaults: [{ field: "category", value: "A quiet default" }],
      links: [expect.objectContaining({ field: "category", format: "markdown", validateExists: true })],
      unique: [expect.objectContaining({ field: "title", scope: "path_glob", pathGlob: "People/**/*.md" })],
      path: expect.objectContaining({ pattern: "People/title.md" })
    });

    await user.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByText("Validation may change")).toBeInTheDocument();
    expect(screen.getByText("Future file paths may change")).toBeInTheDocument();
    expect(screen.getByText(/Display metadata · Read defaults · Link rules · Uniqueness rules · Path policy/)).toBeInTheDocument();
  }, 15_000);

  it("suggests a contract from field shape and waits for an explicit claim", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={contractSource} contracts={[personContract]} />);

    expect(screen.getByText("Possible app compatibility")).toBeInTheDocument();
    expect(screen.getByText("2 of 2 fields match, 1 of 1 required.")).toBeInTheDocument();
    expect(screen.getByTestId("source")).not.toHaveTextContent("implements:");

    await user.click(screen.getAllByRole("button", { name: "Review mapping" })[0]);

    expect(screen.getByText("Mapping ready")).toBeInTheDocument();
    const nameMapping = screen.getByRole("combobox", { name: "example.person name type field" });
    expect(nameMapping).toHaveValue("name");
    expect(within(nameMapping).getByRole("option", { name: "age · Integer" })).toBeDisabled();
    expect(screen.getByText("Required fields covered")).toBeInTheDocument();
    expect(screen.getAllByText(/satisfies the declared contract field constraints/)).toHaveLength(2);
    expect(screen.getByTestId("source")).toHaveTextContent("contract: example.person");
  });

  it("warns when a mapped source field is broader than a required contract field", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness
      source={contractSource.replace("    required: [name]\n", "")}
      contracts={[personContract]}
    />);

    await user.click(screen.getByRole("button", { name: "Review mapping" }));

    expect(screen.getByText("Review recommended")).toBeInTheDocument();
    expect(screen.getByText(/name is optional, so some records may omit this required value/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  });

  it("keeps application mappings aligned when a user renames a field", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={contractSource} contracts={[personContract]} />);

    await user.click(screen.getByRole("button", { name: "Review mapping" }));
    const nameField = screen.getByDisplayValue("name");
    await user.clear(nameField);
    await user.type(nameField, "display_name");
    await user.tab();

    expect(screen.getByRole("combobox", { name: "example.person name type field" })).toHaveValue("display_name");
    expect(screen.getByTestId("source")).toHaveTextContent("name: display_name");
    expect(screen.getByText("Mapping ready")).toBeInTheDocument();
  });

  it("connects one type to more than one application contract", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={contractSource} contracts={[personContract, directoryContract]} />);

    await user.click(screen.getAllByRole("button", { name: "Review mapping" })[0]);
    await user.click(screen.getByRole("button", { name: "Connect application contract" }));

    expect(screen.getByText("example.person")).toBeInTheDocument();
    expect(screen.getByText("example.directory-entry")).toBeInTheDocument();
    expect(screen.getByText("2 connections configured")).toBeInTheDocument();
    expect(screen.getByTestId("source").textContent?.match(/contract:/gu)).toHaveLength(2);
  });

  it("shows installed linked-schema fields as ready-made rather than empty", () => {
    const source = `---
kind: mdbase.type
name: person
schema:
  dialect: json-schema-2020-12
  ref: ../schemas/person.schema.json
---
`;
    render(<InspectorHarness
      source={source}
      type={{
        ...typeDescriptor,
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Display name" },
            email: { type: "string", format: "email" }
          }
        }
      }}
    />);

    expect(screen.getByText("Schema-managed fields")).toBeInTheDocument();
    expect(screen.getByText("../schemas/person.schema.json")).toBeInTheDocument();
    expect(screen.getByText("2 fields are supplied by the installed schema.")).toBeInTheDocument();
    expect(screen.getByText("Display name")).toBeInTheDocument();
    expect(screen.queryByText("No fields are declared yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add field" })).not.toBeInTheDocument();
  });

  it("blocks review until required contract fields are mapped", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={contractSource} contracts={[legalPersonContract]} />);

    await user.click(screen.getByRole("button", { name: "Connect application contract" }));

    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Map required contract field legal_name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: "example.legal-person legal_name type field" }), "name");
    expect(screen.getByText("Mapping ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  });

  it("edits contract behavior settings from their JSON Schema and previews the app view", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={contractSource} contracts={[workflowContract]} />);

    await user.click(screen.getByRole("button", { name: "Connect application contract" }));
    expect(screen.getByText("Setup required")).toBeInTheDocument();
    expect(screen.getByText("Binding setting status is required by example.workflow-person.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Configure settings" }));
    expect(screen.getByText("Application behavior")).toBeInTheDocument();
    expect(screen.getByText(/Control how compatible apps interpret and act on this type/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove completed_values item 1" })).toHaveClass(
      "icon-button",
      "inline-remove-button",
      "schema-remove-value"
    );
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    await user.type(screen.getByLabelText("completed_values item 1"), "done");
    await user.type(screen.getByLabelText("default"), "open");

    await user.click(screen.getByText("Application view").closest("summary")!);
    expect(screen.getByText(/"name": "← name"/)).toBeInTheDocument();
    expect(screen.getByTestId("source")).toHaveTextContent("completed_values:");
    expect(screen.getByTestId("source")).toHaveTextContent("- done");
    expect(screen.getByTestId("source")).toHaveTextContent("default: open");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  });

  it("uses an installed contract as a new-type starting point", async () => {
    const user = userEvent.setup();
    render(<InspectorHarness source={NEW_TYPE_SOURCE} contracts={[personContract]} creating />);

    await user.click(screen.getByRole("button", { name: "Use contract" }));

    expect(screen.getByDisplayValue("person-2")).toBeInTheDocument();
    expect(screen.getByText("Mapping ready")).toBeInTheDocument();
    expect(screen.getByTestId("source")).toHaveTextContent("contract: example.person");
  });

  it("shows catalog packs in a separate collection workspace", () => {
    render(<PackHarness catalog={contractCatalog} />);

    expect(screen.getByRole("heading", { name: "Add a type" })).toBeInTheDocument();
    expect(screen.getByText(/Existing files are never overwritten/)).toBeInTheDocument();
    expect(screen.getByText("From mdbase")).toBeInTheDocument();
    expect(screen.getByText("Person")).toBeInTheDocument();
    expect(screen.getByText("Adds 1 type")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View pack JSON" })).toHaveAttribute(
      "href",
      "https://mdbase.dev/contracts/packs/example.people/1.0.0/provision.json"
    );
  });

  it("recognises a catalog pack whose contract is installed in the collection", () => {
    render(<PackHarness
      contracts={[personContract]}
      types={[typeDescriptor, { ...typeDescriptor, name: "starter-person" }]}
      catalog={contractCatalog}
    />);

    expect(screen.getByText("Person added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Person" })).not.toBeInTheDocument();
  });

  it("offers to reload an unavailable catalog", async () => {
    const user = userEvent.setup();
    const onReloadCatalog = vi.fn();
    render(<PackHarness
      error="The contract catalog returned 503."
      onReload={onReloadCatalog}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("Catalog unavailable");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReloadCatalog).toHaveBeenCalledOnce();
  });

  it("confirms a catalog pack before installing it", async () => {
    const user = userEvent.setup();
    const onInstallPack = vi.fn(async () => undefined);
    render(<PackHarness
      catalog={contractCatalog}
      canInstall
      onInstall={onInstallPack}
    />);

    await user.click(screen.getByRole("button", { name: "Add Person" }));
    const confirmation = screen.getByRole("alert");
    expect(confirmation).toHaveTextContent("Add Person?");
    expect(confirmation).toHaveTextContent("ready-to-use Person type");
    expect(confirmation).toHaveTextContent("editable contract mapping");
    expect(confirmation).toHaveTextContent("will not be overwritten");
    expect(onInstallPack).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole("button", { name: "Add Person" }));
    expect(onInstallPack).toHaveBeenCalledWith(contractCatalog.packs[0]);
  });

  it("requests expanded collection access when pack installation is not granted", async () => {
    const user = userEvent.setup();
    const onRequestPackAccess = vi.fn();
    render(<PackHarness
      catalog={contractCatalog}
      onInstall={vi.fn()}
      onRequestAccess={onRequestPackAccess}
    />);

    await user.click(screen.getByRole("button", { name: "Allow installs" }));
    expect(onRequestPackAccess).toHaveBeenCalledOnce();
  });
});

function InspectorHarness({ source: initialSource = recursiveSource, contracts = [], notes = [], explicitTypeKeys, creating = false, onBrowsePacks, type = typeDescriptor }: {
  source?: string;
  contracts?: CollectionContractDescriptor[];
  notes?: NoteSummary[];
  explicitTypeKeys?: string[];
  creating?: boolean;
  onBrowsePacks?: () => void;
  type?: CollectionTypeDescriptor;
}) {
  const [source, setSource] = useState(initialSource);
  return <>
    <TypeInspector
      type={type}
      availableTypes={[typeDescriptor, organisationDescriptor]}
      contracts={contracts}
      document={{ ...typeDocument, document: initialSource }}
      source={source}
      notes={notes}
      explicitTypeKeys={explicitTypeKeys}
      creating={creating}
      loading={false}
      saving={false}
      onSourceChange={setSource}
      onSave={vi.fn()}
      onRevert={vi.fn()}
      onCancel={vi.fn()}
      onCreate={vi.fn()}
      onBrowsePacks={onBrowsePacks}
      onBack={vi.fn()}
    />
    <output data-testid="source">{source}</output>
  </>;
}

function noteSummary(
  path: string,
  frontmatter: NoteSummary["frontmatter"],
  types: string[]
): NoteSummary {
  return {
    path,
    frontmatter,
    effective_frontmatter: structuredClone(frontmatter),
    types,
    file: {
      path,
      name: path,
      folder: "",
      size: 0,
      mtime: ""
    }
  };
}

function PackHarness({ contracts = [], types = [typeDescriptor], catalog, loading = false, error, canInstall = false, onInstall, onRequestAccess, onReload }: {
  contracts?: CollectionContractDescriptor[];
  types?: CollectionTypeDescriptor[];
  catalog?: ContractCatalog;
  loading?: boolean;
  error?: string;
  canInstall?: boolean;
  onInstall?: (pack: ContractCatalog["packs"][number]) => Promise<void>;
  onRequestAccess?: () => void;
  onReload?: () => void;
}) {
  return <TypePackBrowser
    types={types}
    contracts={contracts}
    catalog={catalog}
    loading={loading}
    error={error}
    canInstall={canInstall}
    onInstall={onInstall}
    onRequestAccess={onRequestAccess}
    onReload={onReload}
    onBack={vi.fn()}
  />;
}

const recursiveSource = `---
kind: mdbase.type
name: person
description: A person
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title:
        type: string
      category:
        type: string
        enum: [personal, work]
      profile:
        type: object
        additionalProperties: false
        properties:
          display_name:
            type: string
        required: [display_name]
    required: [title]
---
`;

const advancedMatchSource = recursiveSource.replace("description: A person", `description: A person
match:
  path_glob: "People/**/*.md"
  fields_present: [profile]
  where:
    status:
      neq: archived`);

const collectionSource = recursiveSource.replace("schema:", `collection:
  display:
    name_field: title
    description_field: profile.display_name
    icon: person
  read_defaults:
    category: personal
  links:
    category:
      target_type: person
      format: wikilink
  unique:
    - field: title
      scope: type
  path:
    pattern: "People/{title}.md"
  projections:
    label:
      expr: title
schema:`);

const contractSource = `---
kind: mdbase.type
name: person
version: 1
description: A person
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [name]
    properties:
      name: { type: string }
      email: { type: string }
      age: { type: integer }
---
`;

const typeDescriptor: CollectionTypeDescriptor = {
  name: "person",
  path: "_types/person.md",
  description: "A person",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      category: { type: "string", enum: ["personal", "work"] },
      profile: {
        type: "object",
        properties: { display_name: { type: "string" } },
        required: ["display_name"]
      }
    }
  },
  extensions: {}
};

const organisationDescriptor: CollectionTypeDescriptor = {
  name: "organisation",
  path: "_types/organisation.md",
  description: "An organisation",
  schema: { type: "object", properties: { title: { type: "string" } } },
  extensions: {}
};

const typeDocument: TypeDocument = {
  name: "person",
  path: "_types/person.md",
  revision: "type-revision-1",
  document: recursiveSource
};

const personContract: CollectionContractDescriptor = {
  contract_type: "record",
  id: "example.person",
  version: "1.0.0",
  digest: `sha256:${"1".repeat(64)}`,
  schema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      email: { type: "string" }
    }
  },
  implementations: [{
    type_name: "legacy-person",
    type_version: 1,
    digest: `sha256:${"2".repeat(64)}`,
    fields: { name: "name" }
  }]
};

const contractCatalog: ContractCatalog = {
  catalogVersion: 2,
  id: "example.contracts",
  name: "Example contracts",
  description: "Contract packs used by these tests.",
  homepage: "https://mdbase.dev/contracts/",
  publisher: {
    name: "mdbase",
    url: "https://mdbase.dev/"
  },
  sourceUrl: "https://mdbase.dev/contracts/catalog.json",
  contracts: [],
  packs: [{
    id: "example.people",
    version: "1.0.0",
    name: "People starter",
    description: "A portable person type.",
    digest: `sha256:${"4".repeat(64)}`,
    provisionUrl: "https://mdbase.dev/contracts/packs/example.people/1.0.0/provision.json",
    provides: [{
      id: personContract.id,
      version: personContract.version
    }],
    resourceCount: 3,
    displayName: "Person",
    summary: "Store people with names and email addresses.",
    category: "people",
    audience: "general",
    icon: "address-book",
    badges: ["Example standard"],
    visibility: "default",
    recommendation: "user",
    primaryType: "starter-person",
    installedTypes: [{ name: "starter-person", label: "Person" }]
  }]
};

const legalPersonContract: CollectionContractDescriptor = {
  ...personContract,
  id: "example.legal-person",
  digest: `sha256:${"3".repeat(64)}`,
  schema: {
    type: "object",
    required: ["legal_name"],
    properties: {
      legal_name: { type: "string" }
    }
  }
};

const directoryContract: CollectionContractDescriptor = {
  ...personContract,
  id: "example.directory-entry",
  digest: `sha256:${"6".repeat(64)}`
};

const workflowContract: CollectionContractDescriptor = {
  ...personContract,
  id: "example.workflow-person",
  digest: `sha256:${"5".repeat(64)}`,
  schema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Name shown to the application." }
    }
  },
  binding_schema: {
    type: "object",
    required: ["status"],
    properties: {
      status: { $ref: "#/$defs/statusPolicy" }
    },
    $defs: {
      nonEmptyString: {
        type: "string",
        minLength: 1
      },
      stringSet: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/nonEmptyString" }
      },
      statusPolicy: {
        type: "object",
        required: ["completed_values", "default"],
        properties: {
          completed_values: {
            type: "array",
            minItems: 1,
            description: "Statuses that count as complete.",
            items: { $ref: "#/$defs/nonEmptyString" }
          },
          default: { $ref: "#/$defs/nonEmptyString" }
        }
      }
    }
  }
};
