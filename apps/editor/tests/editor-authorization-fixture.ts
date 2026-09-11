import { expect } from "@playwright/test";
import manifest from "../public/.well-known/mdbase-app.json" with { type: "json" };

// Use the generated production declaration for registration responses, while
// explicitly pinning the bundled Editor's new semantic-v2 permissions.
export const editorRequirements = manifest.requirements;

export function expectEditorRegistration(body: unknown): void {
  expect(editorRequirements).toEqual({
    contracts: [],
    access: "full_collection",
    capabilities: {
      contract_version: 2,
      required: [
        "collection.read",
        "records.create",
        "records.edit",
        "records.delete",
        "definitions.manage"
      ],
      optional: []
    },
    files: {
      required: ["list", "read"],
      optional: ["add"],
      scope: { kind: "collection" }
    }
  });
  expect(body).toMatchObject({
    manifest: { manifest_version: 1, id: "dev.mdbase.editor" }
  });
  expect((body as { manifest: { requirements: unknown } }).manifest.requirements)
    .toEqual(editorRequirements);
}
