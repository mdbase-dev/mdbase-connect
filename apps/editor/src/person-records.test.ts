import { describe, expect, it } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import { contactPersonPatch, identityPatch, matchingPerson, newPersonProperties, personRecords } from "./person-records";

const implementation = { typeName: "contact", typeVersion: 1, digest: "digest", fields: { id: "uid", name: "/profile/name", identities: "/profile/accounts" } };
const description = { contracts: [{ id: "mdbase.person", version: "1.0.0", implementations: [implementation] }] } as unknown as CollectionDescription;
const identity = { issuer: "https://connect.example", subject: "Account_A" };
function note(path = "contacts/callum.md", uid = "person_a", accounts = [identity]): NoteSummary {
  return { path, types: ["contact"], frontmatter: { uid, profile: { name: "Callum", accounts } }, effectiveFrontmatter: {}, file: {} };
}

describe("portable person records", () => {
  it("resolves an existing contact through custom mapped fields", () => {
    const records = personRecords(description, [note()]);
    expect(matchingPerson(records, identity)).toMatchObject({ id: "person_a", name: "Callum", path: "contacts/callum.md" });
    expect(matchingPerson(records, { ...identity, subject: "account_a" })).toBeUndefined();
    expect(matchingPerson(records, { ...identity, issuer: identity.issuer + "/" })).toBeUndefined();
  });
  it("never picks the first duplicate identity or person ID", () => {
    expect(() => matchingPerson(personRecords(description, [note(), note("other.md", "person_b")]), identity)).toThrow("Multiple person");
    expect(() => matchingPerson(personRecords(description, [note(), note("other.md", "person_a", [])]), identity)).toThrow("Multiple person");
  });
  it("appends a portable association without changing other profile fields or discarding accounts", () => {
    const frontmatter = { uid: "person_a", profile: { name: "Local label", accounts: [{ issuer: "https://other.example", subject: "Another" }] } };
    const patch = identityPatch(frontmatter, implementation, identity);
    expect(patch).toEqual({ profile: { name: "Local label", accounts: [...frontmatter.profile.accounts, identity] } });
    expect(identityPatch({ ...frontmatter, ...patch }, implementation, identity)).toEqual(patch);
  });
  it("seeds fresh portable IDs and mapped account fields without storing credentials", () => {
    const properties = newPersonProperties(implementation, identity, "My label");
    expect(properties.uid).toMatch(/^person_/);
    expect(properties.profile).toEqual({ name: "My label", accounts: [identity] });
    expect(newPersonProperties(implementation, identity, "My label").uid).not.toBe(properties.uid);
  });
  it("refuses contact conversion that would lose canonical or collection-owned fields", () => {
    const source = { ...implementation, typeName: "legacy", fields: { name: "full_name", primary_email: "email" } };
    const targetContact = { ...implementation, fields: { name: "/profile/name", primary_email: "/profile/email" } };
    const migration = { ...description,
      types: [{ name: "contact", schema: { properties: { type: { const: "contact" } } } }],
      contracts: [...description.contracts, { id: "mdbase.contact", version: "1.0.0", implementations: [source, targetContact] }]
    } as unknown as CollectionDescription;
    const original = { type: "legacy", uid: "stable_id", full_name: "Callum", email: "local@example.com", profile: { other: "Preserve this" } };
    const converted = contactPersonPatch(migration, original, source, implementation, identity);
    expect(converted.personId).toBe("stable_id");
    expect(converted.patch).toEqual({ type: "contact", profile: { other: "Preserve this", name: "Callum", email: "local@example.com", accounts: [identity] } });
    expect(original.profile).toEqual({ other: "Preserve this" });
    expect(() => contactPersonPatch(migration, { ...original, profile: { name: "Different local field" } }, source, implementation, identity)).toThrow("different data");
    expect(() => contactPersonPatch(migration, { ...original, uid: 42 }, source, implementation, identity)).toThrow("portable string ID");
    delete (targetContact.fields as Partial<typeof targetContact.fields>).primary_email;
    expect(() => contactPersonPatch(migration, original, source, implementation, identity)).toThrow("cannot retain");
  });
  it("does not guess when mappings or record identities are invalid", () => {
    const invalid = note(); invalid.frontmatter.uid = "";
    expect(() => personRecords(description, [invalid])).toThrow("invalid Person");
    expect(() => identityPatch({ profile: { accounts: "account" } }, implementation, identity)).toThrow("array");
  });
});
