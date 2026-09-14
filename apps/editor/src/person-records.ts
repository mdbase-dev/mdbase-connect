import type { AccountIdentity, CollectionDescription, CollectionContractImplementationDescriptor, JsonObject } from "@mdbase-dev/connect";
import { readFieldReference, fieldReferencePatch, writeFieldReference } from "./field-reference";
import type { NoteSummary } from "./model";

export function personImplementations(description: CollectionDescription) {
  return description.contracts.find((contract) => contract.id === "mdbase.person" && contract.version === "1.0.0")?.implementations ?? [];
}

export function personField(implementation: CollectionContractImplementationDescriptor, field: "id" | "name" | "identities"): string {
  const reference = implementation.fields[field] ?? implementation.fields[`/${field}`];
  if (!reference) throw new Error(`The ${implementation.typeName} type needs a writable ${field} mapping for mdbase.person.`);
  return reference;
}

export function personRecords(description: CollectionDescription, notes: NoteSummary[]) {
  const implementations = personImplementations(description);
  return notes.flatMap((note) => {
    const matches = implementations.filter((implementation) => note.types.includes(implementation.typeName));
    if (matches.length > 1) throw new Error(`${note.path} implements Person through multiple types. Resolve its mappings before linking.`);
    if (!matches.length) return [];
    const implementation = matches[0];
    const id = readFieldReference(note.frontmatter, personField(implementation, "id"));
    const name = readFieldReference(note.frontmatter, personField(implementation, "name"));
    const identities = readFieldReference(note.frontmatter, personField(implementation, "identities")) ?? [];
    if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()
      || !Array.isArray(identities) || identities.some((identity) => !identity || typeof identity !== "object"
        || typeof identity.issuer !== "string" || typeof identity.subject !== "string")) {
      throw new Error(`${note.path} has invalid Person fields. Edit the record before linking.`);
    }
    return [{ path: note.path, id, name, identities: identities as AccountIdentity[], implementation }];
  });
}

export function matchingPerson(records: ReturnType<typeof personRecords>, identity: AccountIdentity) {
  const matches = records.filter((record) => record.identities.some((candidate) => sameIdentity(candidate, identity)));
  if (matches.length > 1 || matches.some((match) => records.filter((record) => record.id === match.id).length > 1)) {
    throw new Error("Multiple person records match your identity or share its person ID. Resolve the duplicates before linking.");
  }
  return matches[0];
}

export function sameIdentity(left: AccountIdentity, right: AccountIdentity): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}

export function identityPatch(frontmatter: JsonObject, implementation: CollectionContractImplementationDescriptor, identity: AccountIdentity) {
  const field = personField(implementation, "identities");
  const identities = readFieldReference(frontmatter, field) ?? [];
  if (!Array.isArray(identities)) throw new Error("The person identity field must be an array.");
  const next = identities.some((candidate) => candidate && typeof candidate === "object" && sameIdentity(candidate as AccountIdentity, identity))
    ? identities : [...identities, { issuer: identity.issuer, subject: identity.subject }];
  return fieldReferencePatch(frontmatter, field, next);
}

export function newPersonProperties(implementation: CollectionContractImplementationDescriptor, identity: AccountIdentity, name: string): JsonObject {
  let properties = writeFieldReference({}, personField(implementation, "id"), `person_${crypto.randomUUID()}`);
  properties = writeFieldReference(properties, personField(implementation, "name"), name);
  return writeFieldReference(properties, personField(implementation, "identities"), [{ issuer: identity.issuer, subject: identity.subject }]);
}
