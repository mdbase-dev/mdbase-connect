/** Link properties: what a type's `collection.links` rules say about a record's
 * fields, and how one link value is read and written. Whether a link resolves,
 * and to what, stays the collection's answer (`LinkTargets`). */
import type { CollectionTypeDescriptor } from "./connect-types";
import { isObject } from "./field-reference";

export type LinkValueFormat = "wikilink" | "markdown" | "path";

/** A top-level property that holds links to records. */
export interface LinkProperty {
  field: string;
  /** The property is a list of links (`field[]`), not one link. */
  many: boolean;
  /** Types a target must have; empty when any record may be linked. */
  targetTypes: string[];
  /** How a link chosen here is written. */
  format: LinkValueFormat;
}

/** The link rules a type declares for top-level properties, by property name.
 * A rule on `field` is one link; a rule on `field[]` is a list of them. Rules
 * on nested values are not properties of their own and are left out. */
export function typeLinkProperties(type: CollectionTypeDescriptor | undefined): Map<string, LinkProperty> {
  const collection = isObject(type?.collection) ? type.collection
    : isObject(type?.definition) && isObject(type.definition.collection) ? type.definition.collection : undefined;
  const properties = new Map<string, LinkProperty>();
  if (!isObject(collection?.links)) return properties;
  for (const [selector, rule] of Object.entries(collection.links)) {
    const many = selector.endsWith("[]");
    const field = many ? selector.slice(0, -2) : selector;
    if (!field || /[.[\]/]/u.test(field) || !isObject(rule)) continue;
    properties.set(field, {
      field,
      many,
      targetTypes: linkTargetTypes(rule.target_type),
      format: rule.format === "markdown" || rule.format === "path" ? rule.format : "wikilink"
    });
  }
  return properties;
}

/** The link properties of a record with these types; the first type to declare a property wins. */
export function recordLinkProperties(recordTypes: readonly string[], types: readonly CollectionTypeDescriptor[]): Map<string, LinkProperty> {
  const merged = new Map<string, LinkProperty>();
  for (const name of recordTypes) {
    const type = types.find((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    for (const [field, property] of typeLinkProperties(type)) if (!merged.has(field)) merged.set(field, property);
  }
  return merged;
}

/** `target_type` as a list of type names. `any` and an absent rule both mean every type. */
export function linkTargetTypes(value: unknown): string[] {
  const names = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const types = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  return types.some((name) => name.toLocaleLowerCase() === "any") ? [] : types;
}

/** A link value for the record at `path`, in the rule's format. Wikilinks and
 * rooted paths name the record from the collection root, so the value means
 * the same wherever the linking note lives. */
export function linkValue(path: string, title: string, format: LinkValueFormat): string {
  if (format === "path") return `/${path}`;
  // The collection reads no link text with a bracket in it, escaped or not.
  if (format === "markdown") return `[${title.replace(/[[\]]/gu, "")}](</${path}>)`;
  return `[[${path.replace(/\.md$/iu, "")}]]`;
}

/** The value as a link the collection can be asked about (`resolveLinks`): a
 * bare path in a link property is asked as the Markdown link it stands for. */
export function resolvableLinkValue(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^!?\[\[[^\]]+\]\]$/u.test(text) || /^!?\[[^\]]*\]\(.+\)$/u.test(text)) return text;
  return /[<>\n]/u.test(text) ? undefined : `[](<${text}>)`;
}

/** What to call a link value before (or without) the collection's answer: its
 * alias or link text, else the last part of its target without `.md`. */
export function linkValueLabel(value: string): string {
  const text = value.trim();
  const wiki = /^!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/u.exec(text);
  if (wiki) return wiki[2]?.trim() || stem(wiki[1]!);
  const markdown = /^!?\[([^\]]*)\]\(<?([^)>]*)>?\)$/u.exec(text);
  if (markdown) return markdown[1]?.trim() || stem(decoded(markdown[2]!));
  return stem(text);
}

function stem(target: string): string {
  return (target.split("/").at(-1) ?? target).replace(/\.md$/iu, "").trim() || target.trim();
}

function decoded(target: string): string {
  try { return decodeURIComponent(target); } catch { return target; }
}
