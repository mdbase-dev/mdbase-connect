import type { AccountProfile } from "@mdbase-dev/sdk";
import { MdbasePeopleClient, type JsonObject } from "@mdbase-dev/sdk";
import { type CollectionDescription, type DataContractSelector } from "../editor-types";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import { readFieldReference } from "../field-reference";
import type { NoteSummary } from "../model";

/**
 * Gateway people methods backed by fixture notes and the real SDK resolver, so
 * editor tests exercise the same resolution rules as production.
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
    peopleDirectory: async (options?: { signal?: AbortSignal }) => {
      const replica = new MemoryReplica({ contracts: description().contracts.flatMap(contract => contract.implementations.map(implementation => ({
        id: contract.id, version: contract.version, type: implementation.typeName,
        fields: implementation.fields, contractDigest: contract.digest,
      }))) });
      for (const note of notes()) replica.seed({ path: note.path, types: note.types, frontmatter: note.frontmatter });
      const client = await replica.client();
      try {
        const people = new MdbasePeopleClient(client, { collection: replica.collection, request: async () => account, isCurrent: () => true });
        return await people.directory({ members: "omit", signal: options?.signal });
      } finally { client.close(); }
    }
  };
}
