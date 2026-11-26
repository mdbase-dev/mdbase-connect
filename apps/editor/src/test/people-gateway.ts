import {
  PERSON_CONTRACT,
  sameIdentity,
  type AccountIdentity,
  type AccountProfile,
  type CollectionDescription,
  type DataContractSelector,
  type JsonObject,
  type PeopleDirectory,
  type PersonRecord,
  type PersonResolution
} from "../connect-types";
import { readFieldReference } from "../field-reference";
import type { NoteSummary } from "../model";

/**
 * Gateway people methods backed by fixture notes for Editor tests.
 */
export function peopleGateway(account: AccountProfile, description: () => CollectionDescription, notes: () => NoteSummary[]) {
  const queryContract = async ({ id, version, type }: DataContractSelector) => {
    const implementation = description().contracts.find((contract) => contract.id === id && contract.version === version)
      ?.implementations.find((candidate) => candidate.typeName === type);
    if (!implementation) return [];
    return notes().filter((note) => note.types.includes(implementation.typeName)).map((note) => ({
      path: note.path,
      values: Object.fromEntries(Object.entries(implementation.fields).flatMap(([field, reference]) => {
        const value = readFieldReference(note.frontmatter, reference);
        return value === undefined ? [] : [[field.replace(/^\//, ""), value]];
      })) as JsonObject
    }));
  };
  return {
    queryContract,
    peopleDirectory: async (_options?: { signal?: AbortSignal }): Promise<PeopleDirectory> => {
      const contract = description().contracts.find((c) => c.id === PERSON_CONTRACT.id && c.version === PERSON_CONTRACT.version);
      const byPath = new Map<string, { name: string; identities: AccountIdentity[]; typeNames: string[] }>();
      const invalid: PeopleDirectory["invalid"] = [];
      const invalidClaimPaths = new Set<string>();
      for (const implementation of contract?.implementations ?? []) {
        const rows = await queryContract({ id: PERSON_CONTRACT.id, version: PERSON_CONTRACT.version, type: implementation.typeName });
        for (const row of rows) {
          const rawName = row.values.name;
          const rawIdentities = row.values.identities;
          const claims: AccountIdentity[] = Array.isArray(rawIdentities)
            ? rawIdentities.flatMap((entry) => {
                if (!entry || typeof entry !== "object") return [];
                const obj = entry as Record<string, unknown>;
                return typeof obj.issuer === "string" && typeof obj.subject === "string"
                  ? [{ issuer: obj.issuer, subject: obj.subject }]
                  : [];
              })
            : [];
          const hasInvalidClaim = rawIdentities !== undefined
            && (!Array.isArray(rawIdentities) || claims.length !== rawIdentities.length || claims.some((c) => !c.subject.trim()));
          if (typeof rawName !== "string" || !rawName.trim() || hasInvalidClaim) {
            invalid.push({
              id: row.path,
              path: row.path,
              reason: typeof rawName !== "string" || !rawName.trim()
                ? "It needs a non-blank name."
                : "Each account identity needs an exact issuer and subject."
            });
            if (claims.some((c) => sameIdentity(c, account))) invalidClaimPaths.add(row.path);
            continue;
          }
          const existing = byPath.get(row.path);
          if (existing) {
            if (!existing.typeNames.includes(implementation.typeName)) existing.typeNames.push(implementation.typeName);
          } else {
            byPath.set(row.path, { name: rawName, identities: claims, typeNames: [implementation.typeName] });
          }
        }
      }
      const people: PersonRecord[] = [...byPath.entries()].map(([path, entry]) => ({ id: path, path, ...entry }));
      const matching = people.filter((p) => p.identities.some((id) => sameIdentity(id, account)));
      const me: PersonResolution = invalidClaimPaths.size > 0
        ? { status: "invalid", paths: [...invalidClaimPaths] }
        : matching.length === 1
          ? { status: "linked", person: matching[0]! }
          : matching.length > 1
            ? { status: "ambiguous", paths: matching.map((p) => p.path) }
            : { status: "unlinked" };
      return { account, me, people, invalid };
    }
  };
}
