import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionDescription, TypePackAssessment, TypePackProvision } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteSummary } from "./model";
import { YourPersonPanel } from "./YourPersonPanel";
import { peopleGateway } from "./test/people-gateway";
import { loadPersonSetup, requireGuidedPersonSetup } from "./person-setup";
import bundled from "./person-setup.pack.json";
// Real `mdbase packs assess` results (CLI 0.1.0-beta.123) for the bundled 1.3.0
// provision in a collection with mdbase.contact 1.2.0 applied: `unedited` keeps
// the Person v2 seed as installed; `merged` has an edited Markdown body.
import upgrades from "./test/person-starter-upgrade.assessment.json";
import { chooseOption } from "./test/select";

vi.mock("./person-setup", async (original) => ({
  ...await original<typeof import("./person-setup")>(),
  loadPersonSetup: vi.fn(async () => bundled as TypePackProvision)
}));
vi.mock("./NewNoteComposer", () => ({ NewNoteComposer: () => <div role="region" aria-label="Create person form" /> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const empty = { collectionId: "fixture", types: [], contracts: [] } as unknown as CollectionDescription;
const ready = { ...empty, types: [{ name: "person", schema: {} }], contracts: [{ id: "mdbase.person", version: "2.0.0", implementations: [{ typeName: "person", fields: { name: "name", identities: "identities" } }] }] } as unknown as CollectionDescription;
function assessment(): TypePackAssessment {
  return {
    applicable: true, status: "install", assessmentDigest: "reviewed-digest",
    resources: bundled.manifest.resources.map((resource) => ({ ...resource, action: "create" })),
    desired: { id: "mdbase.contact", version: "1.3.0", digest: "digest", installedBy: "dev.mdbase.editor", resources: [] },
    lock: { target: "mdbase.lock.yaml", action: "create", digest: "lock-digest" },
    contractSetups: { choices: [], resources: [] }
  } as TypePackAssessment;
}
const provision = bundled as TypePackProvision;
function upgrade(kind: keyof typeof upgrades): TypePackAssessment {
  return structuredClone(upgrades[kind]) as TypePackAssessment;
}
function personAt(typeVersion: number) {
  return { ...ready, contracts: [{ ...ready.contracts[0], implementations: [{ typeName: "person", typeVersion, typePath: "_types/person.md", fields: { name: "name", identities: "identities" } }] }] } as unknown as CollectionDescription;
}
function fixture(canInstall = true, initial = empty, review = assessment()) {
  let collectionId = "fixture";
  let current = initial;
  const notes: NoteSummary[] = [];
  const gateway = {
    ...peopleGateway({ issuer: "https://connect.example", subject: "account", name: "Example person" }, () => current, () => notes),
    sessionSnapshot: () => ({ status: "ready", connection: { collectionId } }),
    assessTypePack: vi.fn(async () => review),
    applyTypePack: vi.fn(async () => ({})),
    create: vi.fn()
  };
  const refresh = vi.fn(async () => { view.rerender(panel(ready)); return ready; });
  const panel = (description: CollectionDescription) => { current = description; return <YourPersonPanel gateway={gateway as unknown as CollectionGateway} description={description} canCreate canEdit canInstall={canInstall} onRefreshDescription={refresh} />; };
  const view = render(panel(initial));
  return { gateway, notes, review, refresh, view, panel, switchCollection: () => { collectionId = "another"; } };
}
async function review() {
  fireEvent.click(await screen.findByRole("button", { name: "Set up person records" }));
  await screen.findByRole("region", { name: "Review person setup" });
}
it("reviews exact files without writing, then opens creation after explicit approval", async () => {
  const f = fixture();
  await review();
  expect(screen.getByRole("region", { name: "Review person setup" })).toHaveFocus();
  expect(screen.getByText("_types/person.md")).toBeInTheDocument();
  expect(screen.getByText("mdbase.lock.yaml")).toBeInTheDocument();
  expect(f.gateway.applyTypePack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add definitions and continue" }));
  await screen.findByRole("region", { name: "Create person form" });
  expect(f.gateway.applyTypePack).toHaveBeenCalledExactlyOnceWith(bundled, f.review);
  expect(f.gateway.create).not.toHaveBeenCalled();
});
it("cancels without changing any files", async () => {
  const f = fixture(); await review();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("region", { name: "Review person setup" })).toBeNull();
  expect(screen.getByRole("button", { name: "Set up person records" })).toHaveFocus();
  expect(f.gateway.applyTypePack).not.toHaveBeenCalled();
});
it("does not offer setup without definition-management permission", async () => {
  const f = fixture(false);
  expect(await screen.findByRole("button", { name: "Set up person records" })).toBeDisabled();
  expect(f.gateway.assessTypePack).not.toHaveBeenCalled();
});
it("blocks conflicting or replacing definitions before approval", async () => {
  const f = fixture(); f.review.resources[0].action = "update";
  fireEvent.click(await screen.findByRole("button", { name: "Set up person records" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No files have been changed");
  expect(f.gateway.applyTypePack).not.toHaveBeenCalled();
});
it("requires a fresh review after an atomic stale-assessment rejection", async () => {
  const f = fixture(); f.gateway.applyTypePack.mockRejectedValueOnce(new Error("Definitions changed since review"));
  await review(); fireEvent.click(screen.getByRole("button", { name: "Add definitions and continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Definitions changed since review");
  expect(f.refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Add definitions and continue" })).toBeNull();
  expect(f.gateway.applyTypePack).toHaveBeenCalledTimes(1);
});
it("never applies a review to a different selected collection", async () => {
  const f = fixture(); await review(); f.switchCollection();
  fireEvent.click(screen.getByRole("button", { name: "Add definitions and continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("selected collection changed");
  expect(f.gateway.applyTypePack).not.toHaveBeenCalled();
});
it("does not assess after leaving while the bundled definition loads", async () => {
  let resolve!: (value: TypePackProvision) => void;
  vi.mocked(loadPersonSetup).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const f = fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Set up person records" }));
  f.view.unmount(); resolve(bundled as TypePackProvision);
  await waitFor(() => expect(loadPersonSetup).toHaveBeenCalled());
  expect(f.gateway.assessTypePack).not.toHaveBeenCalled();
});
it("still opens creation when a watch observes the approved write before apply returns", async () => {
  let resolve!: (value: object) => void;
  const f = fixture(); f.gateway.applyTypePack.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await review(); fireEvent.click(screen.getByRole("button", { name: "Add definitions and continue" }));
  f.view.rerender(f.panel(ready)); resolve({});
  await screen.findByRole("region", { name: "Create person form" });
});
it("keeps an existing contact selected after setup instead of opening duplicate creation", async () => {
  const f = fixture();
  const contacts = { ...empty, types: [{ name: "contact", schema: {} }], contracts: [{ id: "mdbase.contact", version: "1.0.0", implementations: [{ typeName: "contact", fields: { name: "name" } }] }] } as unknown as CollectionDescription;
  const combined = { ...ready, types: [...contacts.types, ...ready.types], contracts: [...contacts.contracts, ...ready.contracts] };
  f.notes.push({ path: "contact.md", types: ["contact"], frontmatter: { type: "contact", name: "Existing contact" }, effectiveFrontmatter: {}, file: {} });
  f.view.rerender(f.panel(contacts));
  await chooseOption(userEvent.setup(), await screen.findByRole("combobox", { name: "Existing person or contact" }), "contact.md");
  // The new provision does not own or touch the collection's existing Contact type.
  expect(f.review.resources.some((r) => r.target === "_types/contact.md")).toBe(false);
  f.refresh.mockImplementationOnce(async () => { f.view.rerender(f.panel(combined)); return combined; });
  await review(); fireEvent.click(screen.getByRole("button", { name: "Add definitions and continue" }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalled());
  expect(await screen.findByRole("combobox", { name: "Existing person or contact" })).toHaveAttribute("data-value", "contact.md");
  expect(screen.queryByRole("region", { name: "Create person form" })).toBeNull();
  expect(f.gateway.create).not.toHaveBeenCalled();
});
it("will not overwrite an existing Person seed or adopt different unmanaged bytes", () => {
  const existing = assessment(); existing.resources.find((r) => r.target === "_types/person.md")!.action = "preserve";
  expect(() => requireGuidedPersonSetup(provision, existing)).toThrow("already exists");
  const adoption = assessment(); adoption.resources[0].action = "adopt"; adoption.resources[0].currentDigest = "different";
  expect(() => requireGuidedPersonSetup(provision, adoption)).toThrow("No files have been changed");
  adoption.resources[0].currentDigest = adoption.resources[0].digest;
  expect(requireGuidedPersonSetup(provision, adoption)).toEqual({ upgrade: undefined });
});
it("accepts the reviewed Person v2 to v3 starter upgrade, replaced or merged", () => {
  expect(requireGuidedPersonSetup(provision, upgrade("unedited"))).toEqual({ upgrade: { target: "_types/person.md", merged: false } });
  expect(requireGuidedPersonSetup(provision, upgrade("merged"))).toEqual({ upgrade: { target: "_types/person.md", merged: true } });
});
it("sends every other replacement, removal, conflict, or downgrade to Types", () => {
  const person = (plan: TypePackAssessment) => plan.resources.find((r) => r.target === "_types/person.md")!;
  const conflict = upgrade("merged"); conflict.applicable = false; conflict.status = "conflict";
  Object.assign(person(conflict), { action: "conflict", reason: "_types/person.md: Seed upgrade conflicts with customized setting /schema/value/required; review it explicitly." });
  expect(() => requireGuidedPersonSetup(provision, conflict)).toThrow("Seed upgrade conflicts");
  const removal = upgrade("unedited"); removal.resources[0].action = "delete";
  expect(() => requireGuidedPersonSetup(provision, removal)).toThrow("No files have been changed");
  const managed = upgrade("unedited"); managed.resources[0].action = "update";
  expect(() => requireGuidedPersonSetup(provision, managed)).toThrow("No files have been changed");
  const downgrade = upgrade("unedited"); downgrade.status = "downgrade";
  expect(() => requireGuidedPersonSetup(provision, downgrade)).toThrow("No files have been changed");
  // A seed update the pack does not declare: no upgrade_from, or a different installed baseline.
  const undeclared = structuredClone(provision);
  delete undeclared.manifest.resources.find((r) => r.target === "_types/person.md")!.upgrade_from;
  expect(() => requireGuidedPersonSetup(undeclared, upgrade("unedited"))).toThrow("No files have been changed");
  const otherBaseline = upgrade("merged"); person(otherBaseline).installedDigest = "sha256:other";
  expect(() => requireGuidedPersonSetup(provision, otherBaseline)).toThrow("No files have been changed");
});
it("reviews an earlier Person starter as an upgrade that keeps collection edits", async () => {
  const f = fixture(true, personAt(2), upgrade("merged"));
  f.refresh.mockImplementationOnce(async () => { f.view.rerender(f.panel(personAt(3))); return personAt(3); });
  expect(await screen.findByRole("heading", { name: "Person type update available" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review Person type update" }));
  const region = await screen.findByRole("region", { name: "Review person setup" });
  expect(region).toHaveTextContent("Update the Person type?");
  expect(region).toHaveTextContent("Upgrade _types/person.md to the current Person starter. Your edits to this type are kept");
  expect(region).toHaveTextContent("upgrade: _types/person.md");
  expect(f.gateway.applyTypePack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Update definitions and continue" }));
  await screen.findByRole("region", { name: "Create person form" });
  expect(f.gateway.applyTypePack).toHaveBeenCalledExactlyOnceWith(bundled, f.review);
  expect(screen.queryByRole("heading", { name: "Person type update available" })).toBeNull();
});
it("says an unedited Person starter is replaced, and offers no update without type management", async () => {
  fixture(true, personAt(2), upgrade("unedited"));
  fireEvent.click(await screen.findByRole("button", { name: "Review Person type update" }));
  expect(await screen.findByRole("region", { name: "Review person setup" })).toHaveTextContent("It has not been edited since it was added, so it is replaced with the new starter.");
  cleanup();
  const f = fixture(false, personAt(2));
  expect(await screen.findByRole("button", { name: "Create my person record" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review Person type update" })).toBeNull();
  expect(f.gateway.assessTypePack).not.toHaveBeenCalled();
});
