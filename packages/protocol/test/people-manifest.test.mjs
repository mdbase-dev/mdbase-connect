import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedPeoplePermissions } from "../dist/index.js";
import { parseAppManifest, validateAppManifest, validateVersionedAppManifest } from "../dist/manifest.js";

const manifest = {
  manifest_version: 1, id: "dev.example.people", name: "People",
  homepage: "https://people.example", redirect_uris: ["https://people.example/callback"],
  requirements: { access: "full_collection", contracts: [], capabilities: { contract_version: 2, required: ["collection.read"] } },
};
const withPeople = (people) => ({ ...manifest, requirements: { ...manifest.requirements, people } });

test("people consent is explicit and preserved in the exact application declaration", () => {
  assert.equal(Object.hasOwn(parseAppManifest(manifest).requirements, "people"), false);
  for (const people of [{ version: 1, required: ["identity"], optional: ["members"] }, { version: 1, optional: ["identity", "members"] }]) {
    assert.deepEqual(parseAppManifest(withPeople(people)).requirements.people, people);
    assert.notDeepEqual(parseAppManifest(manifest), parseAppManifest(withPeople(people)));
  }
});

test("unknown, empty, duplicate, overlapping and unversioned people permissions fail closed", () => {
  for (const people of [true, {}, { version: 1 }, { required: ["identity"] }, { version: 2, required: ["identity"] },
    { version: 1, required: [] }, { version: 1, optional: [] }, { version: 1, required: ["identity", "identity"] },
    { version: 1, required: ["email"] }, { version: 1, required: ["identity"], optional: ["identity"] },
    { version: 1, permissions: ["identity"] }]) {
    assert.equal(validateAppManifest(withPeople(people)).valid, false, JSON.stringify(people));
  }
});

test("approval requires required permissions and only declared optional permissions", () => {
  const people = { version: 1, required: ["identity"], optional: ["members"] };
  assert.deepEqual(approvedPeoplePermissions(people), ["identity", "members"]);
  assert.deepEqual(approvedPeoplePermissions(people, ["identity"]), ["identity"]);
  assert.deepEqual(approvedPeoplePermissions({ version: 1, optional: ["identity", "members"] }, []), []);
  assert.throws(() => approvedPeoplePermissions(people, ["members"]), /Required/);
  assert.throws(() => approvedPeoplePermissions({ version: 1, optional: ["identity"] }, ["members"]), /declared/);
  assert.throws(() => approvedPeoplePermissions(undefined, ["identity"]), /declaration/);
  assert.deepEqual(approvedPeoplePermissions(undefined), []);
});

test("legacy declarations do not acquire people authority", () => {
  const candidate = withPeople({ version: 1, required: ["identity"] });
  candidate.requirements.capabilities = { contract_version: 1, required: ["records.read"] };
  candidate.requirements.access = "full_collection";
  assert.equal(validateVersionedAppManifest(candidate).valid, false);
});
