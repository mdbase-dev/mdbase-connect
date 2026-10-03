import document from "./person-setup.pack.json?raw";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { loadPersonSetup, outdatedPersonStarter } from "./person-setup";

const bytes = new TextEncoder().encode(document);
afterEach(() => vi.unstubAllGlobals());
it("loads the exact SHA-pinned canonical People/Contact provision without a catalog request", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes).buffer));
  vi.stubGlobal("fetch", fetcher);
  const provision = await loadPersonSetup();
  expect(provision).toEqual(JSON.parse(document));
  expect(provision.manifest.id).toBe("mdbase.contact");
  expect(provision.manifest.version).toBe("1.4.0");
  expect(provision.manifest.resources).toHaveLength(7);
  expect(provision.manifest.resources.filter(({ kind }) => kind === "type").map(({ target }) => target)).toEqual(["_types/person.md"]);
  const person = provision.resources.find(({ source }) => source === "types/person/3.md")?.document;
  expect(person).toContain("no first/last-name split is required");
  // Settings offers the reviewed upgrade only to older starters at the bundled seed's path.
  const version = Number(/^version: (\d+)$/m.exec(person!)?.[1]);
  const starter = (typeVersion: number, typePath = "_types/person.md", contractVersion = "2.0.0") => ({ contracts: [
    { id: "mdbase.contact", version: "1.0.0", implementations: [{ typeName: "contact", typeVersion: 1, typePath: "_types/contact.md", digest: "", fields: {} }] },
    { id: "mdbase.person", version: contractVersion, implementations: [{ typeName: "person", typeVersion, typePath, digest: "", fields: {} }] }
  ] as CollectionDescription["contracts"] });
  expect(outdatedPersonStarter(starter(version - 1))).toBeDefined();
  // The Person v1 starter implements mdbase.person 1.0.0 and is offered the same upgrade.
  expect(outdatedPersonStarter(starter(version - 2, "_types/person.md", "1.0.0"))).toMatchObject({ typeVersion: 1 });
  expect(outdatedPersonStarter(starter(version))).toBeUndefined();
  expect(outdatedPersonStarter(starter(version - 1, "_types/people.md"))).toBeUndefined();
  // Collections record a note's type under settings.explicit_type_keys, which need
  // not be `type`; the Person starter must neither declare nor require it.
  expect(person).toContain("    required: [name]\n");
  expect(person).not.toMatch(/^ {6}type:$/m);
  // Person v3 upgrades either earlier starter: the exact Person v2 seed from 1.2.0
  // and the Person v1 seed from 1.1.0.
  expect(provision.manifest.resources.find(({ target }) => target === "_types/person.md")?.upgrade_from).toMatchObject([
    { version: 2, digest: "sha256:aa81c2964285ecc69fcb96bca4b6ae80bbddeb648908d840d7c7be50df15b362" },
    { version: 1, digest: "sha256:18896ac3086c7fdcb64748babd7dd8263dbece4fcc6bcf43a53f74d51bcece5e" }
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).not.toContain("mdbase.dev/contracts");
});
it("rejects a tampered bundled provision before collection assessment", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(document + " ")));
  await expect(loadPersonSetup()).rejects.toThrow("does not match its catalog digest");
});
