import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MdbaseConnectError, type CollectionDescription } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteSummary } from "./model";
import { YourPersonPanel } from "./YourPersonPanel";
import { peopleGateway } from "./test/people-gateway";
import { chooseOption } from "./test/select";

vi.mock("./NewNoteComposer", () => ({ NewNoteComposer: (props: { initialTitle: string; initialProperties: object; defaultType: string; onCreate(input: unknown): Promise<void> }) =>
  <button type="button" onClick={() => void props.onCreate({ title: props.initialTitle, properties: props.initialProperties, type: props.defaultType, path: "contacts/new.md", body: "" })}>Create fixture person</button>
}));
afterEach(cleanup);
const identity = { issuer: "https://connect.example", subject: "account", name: "Account name" };
const implementation = { typeName: "contact", typeVersion: 1, digest: "digest", fields: { name: "/profile/name", identities: "/profile/accounts" } };
const description = { collectionId: "collection", types: [{ name: "contact", schema: {} }], contracts: [{ id: "mdbase.person", version: "2.0.0", implementations: [implementation] }] } as unknown as CollectionDescription;
function fixture(current: () => CollectionDescription = () => description) {
  const notes: NoteSummary[] = [{ path: "contacts/existing.md", types: ["contact"], frontmatter: { uid: "person_one", profile: { name: "Existing contact", accounts: [] } }, effectiveFrontmatter: {}, file: {} }];
  const gateway = {
    ...peopleGateway(identity, current, () => notes),
    sessionSnapshot: () => ({ status: "ready", connection: { collectionId: "collection" } }),
    read: vi.fn(async () => ({ ...notes[0], revision: "revision" })),
    updateProperties: vi.fn(async (_path: string, patch: object) => { notes[0].frontmatter = { ...notes[0].frontmatter, ...patch }; }),
    create: vi.fn(async () => {}),
  };
  return { gateway, notes, render: (canEdit = true) => render(<YourPersonPanel gateway={gateway as unknown as CollectionGateway} description={description} canCreate canEdit={canEdit} />) };
}
it("links an existing contact with mapped fields without replacing its name or local fields", async () => {
  const f = fixture(); f.render();
  await chooseOption(userEvent.setup(), await screen.findByRole("combobox", { name: "Existing person or contact" }), "contacts/existing.md");
  fireEvent.click(screen.getByRole("button", { name: "Link this record to me" }));
  await waitFor(() => expect(f.gateway.updateProperties).toHaveBeenCalledWith("contacts/existing.md", {
    profile: { name: "Existing contact", accounts: [{ issuer: identity.issuer, subject: identity.subject }] }
  }, "revision"));
  expect(f.notes[0].frontmatter.uid).toBe("person_one");
  await screen.findByText(/Linked to/);
});
it("prefills normal record creation with the account name and portable identity", async () => {
  const f = fixture(); f.render();
  await screen.findByRole("button", { name: "Create my person record" });
  expect(screen.queryByRole("combobox", { name: "Person type" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create my person record" }));
  fireEvent.click(screen.getByRole("button", { name: "Create fixture person" }));
  await waitFor(() => expect(f.gateway.create).toHaveBeenCalledWith(expect.objectContaining({
    title: "Account name", type: "contact", properties: { profile: { name: "Account name", accounts: [{ issuer: identity.issuer, subject: identity.subject }] } }
  })));
});
it("only shows a type choice when the collection has multiple compatible types", async () => {
  const multiple = { ...description,
    types: [...description.types, { name: "person", schema: {} }],
    contracts: [{ ...description.contracts[0], implementations: [implementation, { ...implementation, typeName: "person" }] }]
  } as unknown as CollectionDescription;
  const f = fixture(() => multiple);
  render(<YourPersonPanel gateway={f.gateway as unknown as CollectionGateway} description={multiple} canCreate canEdit />);
  await chooseOption(userEvent.setup(), await screen.findByRole("combobox", { name: "Person type" }), "person");
  fireEvent.click(screen.getByRole("button", { name: "Create my person record" }));
  fireEvent.click(screen.getByRole("button", { name: "Create fixture person" }));
  await waitFor(() => expect(f.gateway.create).toHaveBeenCalledWith(expect.objectContaining({ type: "person" })));
});
it("requires explicit review before converting a Contact-only note, preserving its local fields", async () => {
  let current = description;
  const f = fixture(() => current);
  f.notes[0].frontmatter.type = "contact";
  f.notes[0].frontmatter.private_notes = "Keep this local field";
  const target = { ...implementation, typeName: "person" };
  const contactSource = { ...implementation, fields: { name: "/profile/name" } };
  const convertedDescription = { ...description,
    types: [{ name: "person", schema: { type: "object", properties: { type: { const: "person" } } } }],
    contracts: [
      { id: "mdbase.person", version: "2.0.0", implementations: [target] },
      { id: "mdbase.contact", version: "1.0.0", implementations: [contactSource, { ...contactSource, typeName: "person" }] }
    ]
  } as unknown as CollectionDescription;
  current = convertedDescription;
  render(<YourPersonPanel gateway={f.gateway as unknown as CollectionGateway} description={convertedDescription} canCreate canEdit />);
  await chooseOption(userEvent.setup(), await screen.findByRole("combobox", { name: "Existing person or contact" }), "contacts/existing.md");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Several person records are linked to your account");
  expect(screen.getByRole("alert")).toHaveTextContent("contacts/duplicate.md");
  expect(screen.queryByRole("button", { name: "Link this record to me" })).toBeNull();
  expect(f.gateway.updateProperties).not.toHaveBeenCalled();
});
it("keeps working when an unrelated person record is invalid", async () => {
  const f = fixture();
  f.notes.push({ ...f.notes[0], path: "contacts/broken.md", frontmatter: { profile: { name: " " } } });
  f.render();
  expect(await screen.findByText("1 person record needs attention")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Existing person or contact" })).toBeInTheDocument();
});
it("asks for confirmation before linking a record another account claims", async () => {
  const f = fixture();
  f.notes[0].frontmatter.profile = { name: "Existing contact", accounts: [{ issuer: identity.issuer, subject: "someone-else" }] };
  f.render();
  await chooseOption(userEvent.setup(), await screen.findByRole("combobox", { name: "Existing person or contact" }), "contacts/existing.md");
  expect(screen.getByText(/already linked to another account/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Link this record to me" }));
  fireEvent.click(await screen.findByRole("button", { name: "Link anyway" }));
  await waitFor(() => expect(f.gateway.updateProperties).toHaveBeenCalledOnce());
});
it("offers to review access when the grant does not include the account identity", async () => {
  const f = fixture();
  const allowed = f.gateway.peopleDirectory;
  let approved = false;
  const gateway = {
    ...f.gateway,
    peopleDirectory: vi.fn(async (options?: { signal?: AbortSignal }) => {
      if (!approved) throw new MdbaseConnectError({ code: "access_denied", message: "This application was not approved to read this identity information.", category: "authorization", recovery: "reauthorize" } as never);
      return allowed(options);
    }),
    authorize: vi.fn(async () => { approved = true; })
  };
  render(<YourPersonPanel gateway={gateway as unknown as CollectionGateway} description={description} canCreate canEdit />);
  fireEvent.click(await screen.findByRole("button", { name: "Review access" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(gateway.authorize).toHaveBeenCalledWith("selected", { presentation: "popup" }));
  await screen.findByRole("combobox", { name: "Existing person or contact" });
});
