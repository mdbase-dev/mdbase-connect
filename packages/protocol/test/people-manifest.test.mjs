import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAppManifest, validateAppManifest, validateVersionedAppManifest } from "../dist/manifest.js";

const manifest = {
  manifest_version: 1, id: "dev.example.people", name: "People",
  homepage: "https://people.example", redirect_uris: ["https://people.example/callback"],
  requirements: { access: "full_collection", contracts: [], capabilities: { contract_version: 2, required: ["collection.read"] } },
};
const withPeople = (people) => ({ ...manifest, requirements: { ...manifest.requirements, people } });

test("people consent is explicit and preserved in the exact application declaration", () => {
  assert.equal(Object.hasOwn(parseAppManifest(manifest).requirements, "people"), false);
  const people = { version: 1, permissions: ["identity", "members"] };
  assert.deepEqual(parseAppManifest(withPeople(people)).requirements.people, people);
  assert.notDeepEqual(parseAppManifest(manifest), parseAppManifest(withPeople(people)));
});

test("unknown, empty, duplicate and unversioned people permissions fail closed", () => {
  for (const people of [true, {}, { permissions: ["identity"] }, { version: 2, permissions: ["identity"] },
    { version: 1, permissions: [] }, { version: 1, permissions: ["identity", "identity"] },
    { version: 1, permissions: ["email"] }, { version: 1, permissions: ["members"], optional: true }]) {
    assert.equal(validateAppManifest(withPeople(people)).valid, false, JSON.stringify(people));
  }
});

test("legacy declarations do not acquire people authority", () => {
  const candidate = withPeople({ version: 1, permissions: ["identity"] });
  candidate.requirements.capabilities = { contract_version: 1, required: ["records.read"] };
  candidate.requirements.access = "full_collection";
  assert.equal(validateVersionedAppManifest(candidate).valid, false);
});
