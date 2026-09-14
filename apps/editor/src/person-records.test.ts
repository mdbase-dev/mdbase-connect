import { describe, expect, it } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import { identityPatch, matchingPerson, newPersonProperties, personRecords } from "./person-records";

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
  it("does not guess when mappings or record identities are invalid", () => {
    const invalid = note(); invalid.frontmatter.uid = "";
    expect(() => personRecords(description, [invalid])).toThrow("invalid Person");
    expect(() => identityPatch({ profile: { accounts: "account" } }, implementation, identity)).toThrow("array");
  });
});
