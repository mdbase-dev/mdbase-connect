import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionDescription, TypePackAssessment, TypePackProvision } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteSummary } from "./model";
import { YourPersonPanel } from "./YourPersonPanel";
import { loadPersonSetup, requireAdditivePersonSetup } from "./person-setup";
import bundled from "./person-setup.pack.json";

vi.mock("./person-setup", async (original) => ({
  ...await original<typeof import("./person-setup")>(),
  loadPersonSetup: vi.fn(async () => bundled as TypePackProvision)
}));
vi.mock("./NewNoteComposer", () => ({ NewNoteComposer: () => <div role="region" aria-label="Create person form" /> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const empty = { collectionId: "fixture", types: [], contracts: [] } as unknown as CollectionDescription;
const ready = { ...empty, types: [{ name: "person", schema: {} }], contracts: [{ id: "mdbase.person", version: "1.0.0", implementations: [{ typeName: "person", fields: { id: "id", name: "name", identities: "identities" } }] }] } as unknown as CollectionDescription;
function assessment(): TypePackAssessment {
  return {
    applicable: true, status: "install", assessmentDigest: "reviewed-digest",
    resources: bundled.manifest.resources.map((resource) => ({ ...resource, action: "create" })),
    desired: { id: "mdbase.contact", version: "1.1.0", digest: "digest", installedBy: "dev.mdbase.editor", resources: [] },
    lock: { target: "mdbase.lock.yaml", action: "create", digest: "lock-digest" },
    contractSetups: { choices: [], resources: [] }
  } as TypePackAssessment;
}
function fixture(canInstall = true) {
  let collectionId = "fixture";
  const review = assessment();
  const gateway = {
    currentIdentity: vi.fn(async () => ({ issuer: "https://connect.example", subject: "account", name: "Example person" })),
    sessionSnapshot: () => ({ status: "ready", connection: { collectionId } }),
    list: vi.fn(async () => ({ notes: [] as NoteSummary[] })),
    assessTypePack: vi.fn(async () => review),
    applyTypePack: vi.fn(async () => ({})),
    create: vi.fn()
  };
  const refresh = vi.fn(async () => { view.rerender(panel(ready)); return ready; });
  const panel = (description: CollectionDescription) => <YourPersonPanel gateway={gateway as unknown as CollectionGateway} description={description} canCreate canEdit canInstall={canInstall} onRefreshDescription={refresh} />;
  const view = render(panel(empty));
  return { gateway, review, refresh, view, panel, switchCollection: () => { collectionId = "another"; } };
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
  f.gateway.list.mockResolvedValue({ notes: [{ path: "contact.md", types: ["contact"], frontmatter: { type: "contact", name: "Existing contact" }, effectiveFrontmatter: {}, file: {} }] });
  f.view.rerender(f.panel(contacts));
  fireEvent.change(await screen.findByRole("combobox", { name: "Existing person or contact" }), { target: { value: "contact.md" } });
  f.review.resources.find((r) => r.source === "types/contact/2.md")!.action = "preserve";
  f.refresh.mockImplementationOnce(async () => { f.view.rerender(f.panel(combined)); return combined; });
  await review(); fireEvent.click(screen.getByRole("button", { name: "Add definitions and continue" }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalled());
  expect(await screen.findByRole("combobox", { name: "Existing person or contact" })).toHaveValue("contact.md");
  expect(screen.queryByRole("region", { name: "Create person form" })).toBeNull();
  expect(f.gateway.create).not.toHaveBeenCalled();
});
it("will not overwrite an existing Person seed or adopt different unmanaged bytes", () => {
  const existing = assessment(); existing.resources.find((r) => r.source === "types/person/1.md")!.action = "preserve";
  expect(() => requireAdditivePersonSetup(existing)).toThrow("already exists");
  const adoption = assessment(); adoption.resources[0].action = "adopt"; adoption.resources[0].currentDigest = "different";
  expect(() => requireAdditivePersonSetup(adoption)).toThrow("No files have been changed");
  adoption.resources[0].currentDigest = adoption.resources[0].digest;
  expect(() => requireAdditivePersonSetup(adoption)).not.toThrow();
});
