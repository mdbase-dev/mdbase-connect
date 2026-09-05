import { expect } from "@playwright/test";
import manifest from "../public/.well-known/mdbase-app.json" with { type: "json" };

// Use the generated production declaration for registration responses, while
// explicitly pinning the bundled Editor's predecessor bridge permissions.
export const editorRequirements = manifest.requirements;

export function expectEditorRegistration(body: unknown): void {
  expect(editorRequirements).toEqual({
    contracts: [],
    access: "full_collection",
    capabilities: {
      contract_version: 1,
      required: [
        "collection.inspect",
        "records.watch",
        "records.read",
        "records.query",
        "records.validate",
        "records.create",
        "records.update",
        "records.delete",
        "records.rename",
        "files.list",
        "files.read",
        "definitions.read",
        "definitions.create",
        "definitions.update",
        "definitions.type-pack.apply"
      ],
      optional: ["files.add"]
    },
    files: {
      actions: ["list", "read", "add"],
      scope: { kind: "collection" }
    }
  });
  expect(body).toMatchObject({
    manifest: { manifest_version: 1, id: "dev.mdbase.editor" }
  });
  expect((body as { manifest: { requirements: unknown } }).manifest.requirements)
    .toEqual(editorRequirements);
}
