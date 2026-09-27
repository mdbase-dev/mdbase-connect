import { describe, expect, it } from "vitest";
import type { CollectionDescription, PeopleDirectory, PersonRecord } from "@mdbase-dev/connect";
import { claimedByAnotherAccount, contactCandidates, contactPersonPatch, identityPatch, newPersonProperties, writablePersonImplementation } from "./person-records";

const implementation = { typeName: "contact", typeVersion: 1, digest: "digest", fields: { id: "uid", name: "/profile/name", identities: "/profile/accounts" } };
const description = { contracts: [{ id: "mdbase.person", version: "1.0.0", implementations: [implementation] }] } as unknown as CollectionDescription;
const identity = { issuer: "https://connect.example", subject: "Account_A" };
const person = (path: string, id: string, identities = [identity], typeNames = ["contact"]): PersonRecord => ({ path, id, name: "Callum", identities, typeNames });
const directory = (people: PersonRecord[] = [], invalid: PeopleDirectory["invalid"] = []): PeopleDirectory =>
  ({ account: { ...identity, name: "Callum" }, me: { status: "unlinked" }, people, invalid, duplicateIds: [] });

describe("portable person records", () => {
  it("warns before linking a record another account from the same issuer claims", () => {
    expect(claimedByAnotherAccount(person("a.md", "a", [{ ...identity, subject: "Other" }]), identity)).toBe(true);
    expect(claimedByAnotherAccount(person("a.md", "a", [{ issuer: "https://other.example", subject: "Other" }]), identity)).toBe(false);
    expect(claimedByAnotherAccount(person("a.md", "a", [identity]), identity)).toBe(false);
  });
  it("writes identities through exactly one Person implementation", () => {
    expect(writablePersonImplementation(description, person("a.md", "a"))).toBe(implementation);
    const twice = { ...description, contracts: [{ ...description.contracts[0], implementations: [implementation, { ...implementation, typeName: "person" }] }] } as unknown as CollectionDescription;
    expect(() => writablePersonImplementation(twice, person("a.md", "a", [identity], ["contact", "person"]))).toThrow("multiple types");
  });
  it("offers only individual, Contact-only records through the contract", async () => {
    const source = { ...implementation, typeName: "legacy", fields: {} };
    const contacts = { ...description, contracts: [...description.contracts, { id: "mdbase.contact", version: "1.0.0", implementations: [source, { ...source, typeName: "extra" }] }] } as unknown as CollectionDescription;
    const queryContract = async ({ type }: { type?: string }) => type === "legacy"
      ? [{ path: "b.md", values: { name: "Bea" } }, { path: "org.md", values: { name: "Org", kind: "organisation" } },
        { path: "person.md", values: { name: "Already a person" } }, { path: "both.md", values: { name: "Two types" } }, { path: "a.md", values: { name: "Ann", kind: "individual" } }]
      : [{ path: "both.md", values: { name: "Two types" } }];
    const candidates = await contactCandidates({ queryContract }, contacts, directory([person("person.md", "p")]));
    expect(candidates.map((candidate) => [candidate.path, candidate.name, candidate.source.typeName])).toEqual([["a.md", "Ann", "legacy"], ["b.md", "Bea", "legacy"]]);
  });
  it("appends a portable association without changing other profile fields or discarding accounts", () => {
    const frontmatter = { uid: "person_a", profile: { name: "Local label", accounts: [{ issuer: "https://other.example", subject: "Another" }] } };
    const patch = identityPatch(frontmatter, implementation, identity);
    expect(patch).toEqual({ profile: { name: "Local label", accounts: [...frontmatter.profile.accounts, identity] } });
    expect(identityPatch({ ...frontmatter, ...patch }, implementation, identity)).toEqual(patch);
  });
  it("seeds readable unique IDs and mapped account fields without storing credentials", () => {
    const properties = newPersonProperties(implementation, identity, "My label", []);
    expect(properties.uid).toBe("my-label");
    expect(properties.profile).toEqual({ name: "My label", accounts: [identity] });
    expect(newPersonProperties(implementation, identity, "My label", ["my-label"]).uid).toBe("my-label-2");
  });
  it("refuses contact conversion that would lose canonical or collection-owned fields", () => {
    const source = { ...implementation, typeName: "legacy", fields: { name: "full_name", primary_email: "email" } };
    const targetContact = { ...implementation, fields: { name: "/profile/name", primary_email: "/profile/email" } };
    const migration = { ...description,
      types: [{ name: "contact", schema: { properties: { type: { const: "contact" } } } }],
      contracts: [...description.contracts, { id: "mdbase.contact", version: "1.0.0", implementations: [source, targetContact] }]
    } as unknown as CollectionDescription;
    const original = { type: "legacy", uid: "stable_id", full_name: "Callum", email: "local@example.com", profile: { other: "Preserve this" } };
    const converted = contactPersonPatch(migration, original, source, implementation, identity, []);
    expect(converted.personId).toBe("stable_id");
    expect(converted.patch).toEqual({ type: "contact", profile: { other: "Preserve this", name: "Callum", email: "local@example.com", accounts: [identity] } });
    expect(original.profile).toEqual({ other: "Preserve this" });
    expect(() => contactPersonPatch(migration, { ...original, profile: { name: "Different local field" } }, source, implementation, identity, [])).toThrow("different data");
    expect(() => contactPersonPatch(migration, { ...original, uid: 42 }, source, implementation, identity, [])).toThrow("portable string ID");
    delete (targetContact.fields as Partial<typeof targetContact.fields>).primary_email;
    expect(() => contactPersonPatch(migration, original, source, implementation, identity, [])).toThrow("cannot retain");
  });
  it("generates a readable ID for a converted contact without one", () => {
    const source = { ...implementation, typeName: "legacy", fields: { name: "full_name" } };
    const migration = { ...description, types: [{ name: "contact", schema: { properties: {} } }],
      contracts: [...description.contracts, { id: "mdbase.contact", version: "1.0.0", implementations: [source, { ...implementation, fields: { name: "/profile/name" } }] }]
    } as unknown as CollectionDescription;
    expect(contactPersonPatch(migration, { type: "legacy", full_name: "Callum" }, source, implementation, identity, ["callum"]).personId).toBe("callum-2");
  });
  it("keeps a types-list collection from gaining a separate type key", () => {
    const source = { ...implementation, typeName: "legacy", fields: { name: "full_name" } };
    const migration = { ...description, types: [{ name: "contact", schema: { properties: { type: { const: "contact" }, types: { const: ["contact"] } } } }],
      configuration: { settings: { explicit_type_keys: ["type", "types"] } },
      contracts: [...description.contracts, { id: "mdbase.contact", version: "1.0.0", implementations: [source, { ...implementation, fields: { name: "/profile/name" } }] }]
    } as unknown as CollectionDescription;
    const { patch } = contactPersonPatch(migration, { types: ["legacy", "tagged"], full_name: "Callum" }, source, implementation, identity, []);
    expect(patch).not.toHaveProperty("type");
    expect(patch.types).toEqual(["tagged", "contact"]);
  });
  it("does not guess when identity fields are invalid", () => {
    expect(() => identityPatch({ profile: { accounts: "account" } }, implementation, identity)).toThrow("array");
  });
});
