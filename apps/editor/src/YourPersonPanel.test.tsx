import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteSummary } from "./model";
import { YourPersonPanel } from "./YourPersonPanel";

vi.mock("./NewNoteComposer", () => ({ NewNoteComposer: (props: { initialTitle: string; initialProperties: object; defaultType: string; onCreate(input: unknown): Promise<void> }) =>
  <button type="button" onClick={() => void props.onCreate({ title: props.initialTitle, properties: props.initialProperties, type: props.defaultType, path: "contacts/new.md", body: "" })}>Create fixture person</button>
}));
afterEach(cleanup);
const identity = { issuer: "https://connect.example", subject: "account", name: "Account name" };
const implementation = { typeName: "contact", typeVersion: 1, digest: "digest", fields: { id: "uid", name: "/profile/name", identities: "/profile/accounts" } };
const description = { collectionId: "collection", types: [{ name: "contact", schema: {} }], contracts: [{ id: "mdbase.person", version: "1.0.0", implementations: [implementation] }] } as unknown as CollectionDescription;
function fixture() {
  const notes: NoteSummary[] = [{ path: "contacts/existing.md", types: ["contact"], frontmatter: { uid: "person_one", profile: { name: "Existing contact", accounts: [] } }, effectiveFrontmatter: {}, file: {} }];
  const gateway = {
    currentIdentity: vi.fn(async () => identity),
    sessionSnapshot: () => ({ status: "ready", connection: { collectionId: "collection" } }),
    list: vi.fn(async () => ({ notes })),
    read: vi.fn(async () => ({ ...notes[0], revision: "revision" })),
    updateProperties: vi.fn(async (_path: string, patch: object) => { notes[0].frontmatter = { ...notes[0].frontmatter, ...patch }; }),
    create: vi.fn(async () => {}),
  };
  return { gateway, notes, render: (canEdit = true) => render(<YourPersonPanel gateway={gateway as unknown as CollectionGateway} description={description} canCreate canEdit={canEdit} />) };
}
it("links an existing contact with mapped fields without replacing its name or ID", async () => {
  const f = fixture(); f.render();
  fireEvent.change(await screen.findByRole("combobox", { name: "Existing person or contact" }), { target: { value: "contacts/existing.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Link this record to me" }));
  await waitFor(() => expect(f.gateway.updateProperties).toHaveBeenCalledWith("contacts/existing.md", {
    profile: { name: "Existing contact", accounts: [{ issuer: identity.issuer, subject: identity.subject }] }
  }, "revision"));
  expect(f.notes[0].frontmatter.uid).toBe("person_one");
  await screen.findByText(/Linked to/);
});
it("prefills normal record creation with the account name and portable identity", async () => {
  const f = fixture(); f.render();
  fireEvent.click(await screen.findByRole("button", { name: "Create my person record" }));
  fireEvent.click(screen.getByRole("button", { name: "Create fixture person" }));
  await waitFor(() => expect(f.gateway.create).toHaveBeenCalledWith(expect.objectContaining({
    title: "Account name", type: "contact", properties: { uid: expect.stringMatching(/^person_/), profile: { name: "Account name", accounts: [{ issuer: identity.issuer, subject: identity.subject }] } }
  })));
});
it("requires explicit review before converting a Contact-only note, preserving its ID and fields", async () => {
  const f = fixture();
  f.notes[0].frontmatter.type = "contact";
  f.notes[0].frontmatter.private_notes = "Keep this local field";
  const target = { ...implementation, typeName: "person" };
  const contactSource = { ...implementation, fields: { name: "/profile/name" } };
  const convertedDescription = { ...description,
    types: [{ name: "person", schema: { type: "object", properties: { type: { const: "person" } } } }],
    contracts: [
      { id: "mdbase.person", version: "1.0.0", implementations: [target] },
      { id: "mdbase.contact", version: "1.0.0", implementations: [contactSource, { ...contactSource, typeName: "person" }] }
    ]
  } as unknown as CollectionDescription;
  render(<YourPersonPanel gateway={f.gateway as unknown as CollectionGateway} description={convertedDescription} canCreate canEdit />);
  fireEvent.change(await screen.findByRole("combobox", { name: "Existing person or contact" }), { target: { value: "contacts/existing.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Review contact conversion" }));
  expect(await screen.findByRole("region", { name: "Review contact conversion" })).toHaveTextContent("No other contacts or type definitions are changed");
  expect(f.gateway.updateProperties).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Convert and link this contact" }));
  await waitFor(() => expect(f.gateway.updateProperties).toHaveBeenCalledWith("contacts/existing.md", {
    type: "person", profile: { name: "Existing contact", accounts: [{ issuer: identity.issuer, subject: identity.subject }] }
  }, "revision"));
  expect(f.notes[0].frontmatter.uid).toBe("person_one");
  expect(f.notes[0].frontmatter.private_notes).toBe("Keep this local field");
  expect(f.gateway.create).not.toHaveBeenCalled();
});

it("does not let viewers link records", async () => {
  const f = fixture(); f.render(false);
  expect(await screen.findByText("Ask a collection editor to link your person record.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Link this record to me" })).toBeDisabled();
  expect(f.gateway.updateProperties).not.toHaveBeenCalled();
});
it("shows duplicate matches instead of choosing a contact", async () => {
  const f = fixture();
  f.notes[0].frontmatter.profile = { name: "Existing contact", accounts: [identity] };
  f.notes.push({ ...f.notes[0], path: "contacts/duplicate.md" });
  f.render();
  expect(await screen.findByRole("alert")).toHaveTextContent("Multiple person records");
  expect(f.gateway.updateProperties).not.toHaveBeenCalled();
});
