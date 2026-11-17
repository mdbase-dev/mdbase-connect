import { describe, expect, it } from "vitest";
import mdbaseReadme from "../../../templates/mdbase/README.md?raw";
import type { TypePackProvision } from "@mdbase-dev/connect";
import bundled from "./person-setup.pack.json";
import { requireGuidedPersonSetup } from "./person-setup";
import { DemoCollectionGateway } from "./demo-gateway";

describe("DemoCollectionGateway indexing", () => {
  it("uses the requested structure snapshot while hydrating content", async () => {
    const gateway = new DemoCollectionGateway(3);
    const structure = await gateway.list();
    const progressSnapshots: Array<string | undefined> = [];

    const content = await gateway.hydrateContent({
      snapshot: structure.snapshot,
      onProgress: (progress) => { progressSnapshots.push(progress.snapshot); }
    });

    expect(content.snapshot).toBe(structure.snapshot);
    expect(progressSnapshots).toEqual([structure.snapshot]);
    expect(content.notes.every((note) => note.body !== undefined)).toBe(true);
  });

  it("answers body searches as the runtime does: lower-cased text contains the term", async () => {
    const gateway = new DemoCollectionGateway(1);
    const created = await gateway.create({ path: "Notes/Mixed.md", title: "Mixed", body: "Mixed CASE Body", properties: {} });
    expect(await gateway.searchBodies("case body")).toEqual([created.path]);
    // The term is matched as given: an upper-case term matches no lower-cased text.
    expect(await gateway.searchBodies("CASE")).toEqual([]);
  });

  it("answers tag searches as the runtime's hasTag does: frontmatter and inline tags, nested tags included", async () => {
    const gateway = new DemoCollectionGateway(1);
    const inline = await gateway.create({ path: "Notes/Inline.md", title: "Inline", body: "Inline #inlinemarker here.", properties: {} });
    const nested = await gateway.create({ path: "Notes/Nested.md", title: "Nested", body: "Body", properties: { tags: ["project/alpha"] } });
    expect(await gateway.searchTag("inlinemarker")).toEqual([inline.path]);
    expect(await gateway.searchTag("#inlinemarker")).toEqual([inline.path]);
    expect(await gateway.searchTag("project")).toEqual([nested.path]);
    expect(await gateway.searchTag("proj")).toEqual([]);
  });
});

describe("DemoCollectionGateway metadata layout", () => {
  it("creates types and the README under the configured metadata folder", async () => {
    const gateway = new DemoCollectionGateway(1);
    const description = await gateway.describe();
    expect(description.configuration?.settings).toMatchObject({
      types_folder: "_mdbase/types", contracts_folder: "_mdbase/contracts"
    });
    expect((await gateway.readType("note")).path).toBe("_mdbase/types/note.md");
    const created = await gateway.createType("---\nkind: mdbase.type\nname: task\nversion: 1\n---\n");
    expect(created.path).toBe("_mdbase/types/task.md");
    expect((await gateway.read("_mdbase/README.md")).document).toBe(
      mdbaseReadme
    );
    const notes = await gateway.list();
    expect(notes.notes.some((note) => note.path === "_mdbase/README.md")).toBe(true);
  });
});

it("installs the canonical Person pack into the demo's configured folders", async () => {
  const gateway = new DemoCollectionGateway(1);
  const provision = bundled as TypePackProvision;
  const assessment = await gateway.assessTypePack(provision);
  expect(assessment.resources.find((r) => r.kind === "type")?.target).toBe("_mdbase/types/person.md");
  expect(requireGuidedPersonSetup(provision, assessment)).toEqual({});
  const applied = await gateway.applyTypePack(provision, assessment);
  expect(applied.receipt?.resources).toEqual(assessment.desired.resources);
  expect((await gateway.readType("person")).path).toBe("_mdbase/types/person.md");
});
