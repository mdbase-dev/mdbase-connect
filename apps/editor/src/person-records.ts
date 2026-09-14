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

export function contactRecords(description: CollectionDescription, notes: NoteSummary[]) {
  const people = personImplementations(description);
  const contacts = description.contracts.find((contract) => contract.id === "mdbase.contact" && contract.version === "1.0.0")?.implementations ?? [];
  return notes.flatMap((note) => {
    if (people.some((candidate) => note.types.includes(candidate.typeName))) return [];
    const matches = contacts.filter((candidate) => note.types.includes(candidate.typeName));
    if (matches.length !== 1) return [];
    const source = matches[0];
    const name = readFieldReference(note.frontmatter, source.fields.name ?? source.fields["/name"]);
    const kind = readFieldReference(note.frontmatter, source.fields.kind ?? source.fields["/kind"]);
    if (typeof name !== "string" || !name.trim() || (kind !== undefined && kind !== "individual")) return [];
    return [{ path: note.path, name, source }];
  });
}

/** Explicit one-record conversion, never an implicit whole-address-book migration. */
export function contactPersonPatch(
  description: CollectionDescription,
  frontmatter: JsonObject,
  source: CollectionContractImplementationDescriptor,
  target: CollectionContractImplementationDescriptor,
  identity: AccountIdentity,
): { patch: JsonObject; personId: string } {
  const contactTarget = description.contracts.find((contract) => contract.id === "mdbase.contact" && contract.version === "1.0.0")?.implementations.find((candidate) => candidate.typeName === target.typeName);
  if (!contactTarget) throw new Error("Choose a target type that implements both Person and Contact so existing contact semantics are retained.");
  const type = description.types.find((candidate) => candidate.name === target.typeName);
  if (!type) throw new Error("The target person type is unavailable.");
  const settings = description.configuration?.settings;
  const configuredKeys = settings && typeof settings === "object" && !Array.isArray(settings) && "explicit_type_keys" in settings ? settings.explicit_type_keys : undefined;
  const keys = Array.isArray(configuredKeys) ? configuredKeys.filter((key): key is string => typeof key === "string") : ["type", "types"];
  let next = structuredClone(frontmatter);
  const properties = type.schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      if (value && typeof value === "object" && !Array.isArray(value) && "const" in value) {
        if (!keys.includes(key) && frontmatter[key] !== undefined && JSON.stringify(frontmatter[key]) !== JSON.stringify(value.const)) throw new Error(`The target type would overwrite ${key}. Configure compatible mappings first.`);
        next = { ...next, [key]: structuredClone(value.const) };
      }
    }
  }
  const existingKey = keys.find((key) => key in frontmatter) ?? keys[0];
  if (!existingKey) throw new Error("This collection uses implicit type selection. Configure the contact's type explicitly in Types before linking.");
  const declared = frontmatter[existingKey];
  if (declared !== undefined && !Array.isArray(declared) && declared !== source.typeName) throw new Error("This contact has another explicit type. Review its type declarations in the editor first.");
  next = { ...next, [existingKey]: Array.isArray(declared)
    ? [...new Set([...declared.filter((name) => name !== source.typeName), target.typeName])]
    : target.typeName };
  for (const [canonical, field] of Object.entries(source.fields)) {
    const targetField = contactTarget.fields[canonical] ?? contactTarget.fields[canonical.startsWith("/") ? canonical.slice(1) : `/${canonical}`];
    const value = readFieldReference(frontmatter, field);
    if (value !== undefined) {
      if (!targetField) throw new Error(`The target type cannot retain the contact's ${canonical} field. Configure that mapping first.`);
      const existing = readFieldReference(frontmatter, targetField);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`The target ${targetField} field contains different data. Configure a non-conflicting mapping first.`);
      next = writeFieldReference(next, targetField, value);
    }
  }
  const name = readFieldReference(frontmatter, source.fields.name ?? source.fields["/name"]);
  if (typeof name !== "string" || !name.trim()) throw new Error("The contact needs a display name.");
  const existingName = readFieldReference(frontmatter, personField(target, "name"));
  if (existingName !== undefined && existingName !== name) throw new Error("The target person name field contains different data. Configure a non-conflicting mapping first.");
  next = writeFieldReference(next, personField(target, "name"), name);
  const existingId = readFieldReference(frontmatter, personField(target, "id"));
  if (existingId !== undefined && typeof existingId !== "string") throw new Error("The target ID field is not a portable string ID. Configure a separate person-ID field first.");
  const personId = typeof existingId === "string" && existingId.trim() ? existingId : `person_${crypto.randomUUID()}`;
  next = writeFieldReference(next, personField(target, "id"), personId);
  next = { ...next, ...identityPatch(next, target, identity) };
  for (const [canonical, field] of Object.entries(source.fields)) {
    const value = readFieldReference(frontmatter, field);
    const mapped = contactTarget.fields[canonical] ?? contactTarget.fields[canonical.startsWith("/") ? canonical.slice(1) : `/${canonical}`];
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(readFieldReference(next, mapped))) throw new Error("The Person mappings conflict with existing Contact fields. Configure non-overlapping mappings first.");
  }
  return { personId, patch: Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(frontmatter[key]))) };
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
