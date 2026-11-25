import type { JsonSchema } from "@mdbase-dev/ui/properties";
import type { Host } from "./host";
import { isObject } from "./model";

/** What the view needs to know about one approved collection, from describe_collection. */
export interface Collection {
  readonly name: string;
  /** Whether this connection was approved to update records. */
  readonly editable: boolean;
  /** Each type's JSON Schema, by lower-case type name. */
  readonly schemas: ReadonlyMap<string, JsonSchema>;
}

const described = new Map<string, Promise<Collection>>();

/** One describe_collection per connection for the life of the view; a failure is asked again next time. */
export function collection(host: Host, connectionId: string): Promise<Collection> {
  let pending = described.get(connectionId);
  if (!pending) {
    pending = host.read("describe_collection", { connection_id: connectionId }).then(collectionOf);
    pending.catch(() => described.delete(connectionId));
    described.set(connectionId, pending);
  }
  return pending;
}

export function collectionOf(description: Record<string, unknown>): Collection {
  const types = Array.isArray(description.types) ? description.types.filter(isObject) : [];
  return {
    name: typeof description.display_name === "string" ? description.display_name : "",
    editable: Array.isArray(description.operations) && description.operations.includes("update"),
    schemas: new Map(types.flatMap((type) => typeof type.name === "string" && isObject(type.schema)
      ? [[type.name.toLowerCase(), type.schema] as const] : [])),
  };
}

/** The schemas of a record's types, in the record's order; types the collection does not describe are left out. */
export function schemasOf(collection: Collection, types: readonly string[]): JsonSchema[] {
  return types.flatMap((type) => {
    const schema = collection.schemas.get(type.toLowerCase());
    return schema ? [schema] : [];
  });
}
