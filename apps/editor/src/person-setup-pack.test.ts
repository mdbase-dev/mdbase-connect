import document from "./person-setup.pack.json?raw";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionContractImplementationDescriptor } from "@mdbase-dev/connect";
import { loadPersonSetup, outdatedPersonStarter } from "./person-setup";

const bytes = new TextEncoder().encode(document);
afterEach(() => vi.unstubAllGlobals());
it("loads the exact SHA-pinned canonical People/Contact provision without a catalog request", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes).buffer));
  vi.stubGlobal("fetch", fetcher);
  const provision = await loadPersonSetup();
  expect(provision).toEqual(JSON.parse(document));
  expect(provision.manifest.id).toBe("mdbase.contact");
  expect(provision.manifest.version).toBe("1.3.0");
  expect(provision.manifest.resources).toHaveLength(7);
  expect(provision.manifest.resources.filter(({ kind }) => kind === "type").map(({ target }) => target)).toEqual(["_types/person.md"]);
  const person = provision.resources.find(({ source }) => source === "types/person/3.md")?.document;
  expect(person).toContain("no first/last-name split is required");
  // Settings offers the reviewed upgrade only to older starters at the bundled seed's path.
  const version = Number(/^version: (\d+)$/m.exec(person!)?.[1]);
  const starter = (typeVersion: number, typePath = "_types/person.md") => [{ typeName: "person", typeVersion, typePath, digest: "", fields: {} }] as CollectionContractImplementationDescriptor[];
  expect(outdatedPersonStarter(starter(version - 1))).toBeDefined();
  expect(outdatedPersonStarter(starter(version))).toBeUndefined();
  expect(outdatedPersonStarter(starter(version - 1, "_types/people.md"))).toBeUndefined();
  // Collections record a note's type under settings.explicit_type_keys, which need
  // not be `type`; the Person starter must neither declare nor require it.
  expect(person).toContain("    required: [name]\n");
  expect(person).not.toMatch(/^ {6}type:$/m);
  // Person v3 upgrades the exact Person v2 seed from 1.2.0.
  expect(provision.manifest.resources.find(({ target }) => target === "_types/person.md")?.upgrade_from?.digest)
    .toBe("sha256:aa81c2964285ecc69fcb96bca4b6ae80bbddeb648908d840d7c7be50df15b362");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).not.toContain("mdbase.dev/contracts");
});
it("rejects a tampered bundled provision before collection assessment", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(document + " ")));
  await expect(loadPersonSetup()).rejects.toThrow("does not match its catalog digest");
});
