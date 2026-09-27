import { MdbasePeopleClient, type AccountProfile, type CollectionDescription, type DataContractSelector, type JsonObject } from "@mdbase-dev/connect";
import { connectSuccess } from "@mdbase-dev/connect/advanced";
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
  const people = new MdbasePeopleClient({
    request: async () => account,
    describe: async () => connectSuccess(description()),
    queryPages: async function* (input) {
      const results = (await queryContract(input.contract!)).map((record) => ({ path: record.path, frontmatter: record.values }));
      yield connectSuccess({ results, page: 0, offset: 0, loaded: results.length, complete: true });
    }
  } as ConstructorParameters<typeof MdbasePeopleClient>[0]);
  return {
    queryContract,
    peopleDirectory: async (options?: { signal?: AbortSignal }) => {
      const outcome = await people.directory({ members: "omit", signal: options?.signal });
      if (!outcome.ok) throw new Error(outcome.problem.message);
      return outcome.value;
    }
  };
}
