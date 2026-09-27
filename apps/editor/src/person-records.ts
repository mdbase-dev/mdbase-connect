import { PERSON_CONTRACT, sameIdentity } from "@mdbase-dev/connect";
import type { AccountIdentity, CollectionDescription, CollectionContractImplementationDescriptor, JsonObject, PeopleDirectory, PersonRecord } from "@mdbase-dev/connect";
import { readFieldReference, fieldReferencePatch, writeFieldReference } from "./field-reference";
import type { CollectionGateway } from "./model";

export function personImplementations(description: CollectionDescription) {
  return description.contracts.find((contract) => contract.id === PERSON_CONTRACT.id && contract.version === PERSON_CONTRACT.version)?.implementations ?? [];
}

export function personField(implementation: CollectionContractImplementationDescriptor, field: "name" | "identities"): string {
  const reference = implementation.fields[field] ?? implementation.fields[`/${field}`];
  if (!reference) throw new Error(`The ${implementation.typeName} type needs a writable ${field} mapping for mdbase.person.`);
  return reference;
}

export const CONTACT_CONTRACT = { id: "mdbase.contact", version: "1.0.0" } as const;

export interface ContactCandidate {
  path: string;
  name: string;
  source: CollectionContractImplementationDescriptor;
}

/**
 * Individual Contact-only records, read through the contract rather than by
 * scanning notes. Records already projected as Person, or implementing Contact
 * through several types, are never conversion candidates.
 */
export async function contactCandidates(
  gateway: Pick<CollectionGateway, "queryContract">,
  description: CollectionDescription,
  directory: PeopleDirectory,
  signal?: AbortSignal
): Promise<ContactCandidate[]> {
  if (!gateway.queryContract) return [];
  const excluded = new Set([...directory.people, ...directory.invalid].map((record) => record.path));
  const implementations = description.contracts.find((contract) =>
    contract.id === CONTACT_CONTRACT.id && contract.version === CONTACT_CONTRACT.version)?.implementations ?? [];
  const byPath = new Map<string, Array<{ source: CollectionContractImplementationDescriptor; values: JsonObject }>>();
  for (const source of implementations) {
    for (const record of await gateway.queryContract({ ...CONTACT_CONTRACT, type: source.typeName }, { signal })) {
      byPath.set(record.path, [...byPath.get(record.path) ?? [], { source, values: record.values }]);
    }
  }
  return [...byPath].flatMap(([path, entries]) => {
    if (excluded.has(path) || entries.length !== 1) return [];
    const { source, values } = entries[0];
    const { name, kind } = values;
    if (typeof name !== "string" || !name.trim() || (kind !== undefined && kind !== "individual")) return [];
    return [{ path, name, source }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/** The one implementation through which a linked identity can be written. */
export function writablePersonImplementation(description: CollectionDescription, person: PersonRecord) {
  const matches = personImplementations(description).filter((implementation) => person.typeNames.includes(implementation.typeName));
  if (matches.length !== 1) throw new Error(`${person.path} implements Person through multiple types. Resolve its mappings in Types before linking.`);
  return matches[0];
}

/** Another account from the same issuer already claims this record. */
export function claimedByAnotherAccount(person: PersonRecord, identity: AccountIdentity): boolean {
  return person.identities.some((candidate) => candidate.issuer === identity.issuer && !sameIdentity(candidate, identity));
}

/** Explicit one-record conversion, never an implicit whole-address-book migration. */
export function contactPersonPatch(
  description: CollectionDescription,
  frontmatter: JsonObject,
  source: CollectionContractImplementationDescriptor,
  target: CollectionContractImplementationDescriptor,
  identity: AccountIdentity,
): JsonObject {
  const contactTarget = description.contracts.find((contract) => contract.id === CONTACT_CONTRACT.id && contract.version === CONTACT_CONTRACT.version)?.implementations.find((candidate) => candidate.typeName === target.typeName);
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
      // Type keys are handled once below, so a `types` collection never gains `type`.
      if (keys.includes(key)) continue;
      if (value && typeof value === "object" && !Array.isArray(value) && "const" in value) {
        if (frontmatter[key] !== undefined && JSON.stringify(frontmatter[key]) !== JSON.stringify(value.const)) throw new Error(`The target type would overwrite ${key}. Configure compatible mappings first.`);
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
  next = { ...next, ...identityPatch(next, target, identity) };
  for (const [canonical, field] of Object.entries(source.fields)) {
    const value = readFieldReference(frontmatter, field);
    const mapped = contactTarget.fields[canonical] ?? contactTarget.fields[canonical.startsWith("/") ? canonical.slice(1) : `/${canonical}`];
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(readFieldReference(next, mapped))) throw new Error("The Person mappings conflict with existing Contact fields. Configure non-overlapping mappings first.");
  }
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(frontmatter[key])));
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
  const properties = writeFieldReference({}, personField(implementation, "name"), name);
  return writeFieldReference(properties, personField(implementation, "identities"), [{ issuer: identity.issuer, subject: identity.subject }]);
}
