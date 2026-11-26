import type { JsonSchema } from "@mdbase-dev/ui/properties";
import { useEffect, useState } from "react";
import type { Host } from "./host";
import { isObject } from "./model";

/** What the view needs to know about one approved collection, from describe_collection. */
export interface Collection {
  readonly name: string;
  /** Whether this connection was approved to update records. */
  readonly editable: boolean;
  /** Whether this connection was approved to create records. */
  readonly creatable: boolean;
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

let listed: Promise<Record<string, unknown>> | undefined;

/**
 * The link that opens a connection's collection in the mdbase Editor, from list_connections:
 * null when its Connect server names no Editor. One list serves every connection; a failure is
 * asked again next time.
 */
export function editorLink(host: Host, connectionId: string): Promise<string | null> {
  if (!listed) {
    listed = host.read("list_connections", {});
    listed.catch(() => { listed = undefined; });
  }
  return listed.then((result) => {
    const connections = Array.isArray(result.connections) ? result.connections.filter(isObject) : [];
    const link = connections.find((connection) => connection.id === connectionId)?.editor_url;
    return typeof link === "string" ? link : null;
  });
}

/** A link that opens one record in the Editor, from the link that opens its collection. */
export function editorRecordLink(collectionLink: string, path: string): string {
  const url = new URL(collectionLink);
  url.hash = new URLSearchParams({ note: path }).toString();
  return url.href;
}

export function collectionOf(description: Record<string, unknown>): Collection {
  const types = Array.isArray(description.types) ? description.types.filter(isObject) : [];
  return {
    name: typeof description.display_name === "string" ? description.display_name : "",
    editable: Array.isArray(description.operations) && description.operations.includes("update"),
    creatable: Array.isArray(description.operations) && description.operations.includes("create"),
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

/** The collection's description once it is known; without one the view shows records read-only. */
export function useCollection(host: Host, connectionId: string): Collection | null {
  return useLookup(collection, host, connectionId);
}

/** The collection's Editor link once it is known; without one there is no way to open the Editor. */
export function useEditorLink(host: Host, connectionId: string): string | null {
  return useLookup(editorLink, host, connectionId);
}

function useLookup<Value>(look: (host: Host, connectionId: string) => Promise<Value>, host: Host, connectionId: string): Value | null {
  const [found, setFound] = useState<Value | null>(null);
  useEffect(() => {
    let current = true;
    look(host, connectionId).then((value) => { if (current) setFound(value); }, () => undefined);
    return () => { current = false; };
  }, [look, host, connectionId]);
  return found;
}
