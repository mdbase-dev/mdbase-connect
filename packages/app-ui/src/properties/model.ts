import type { FilterFieldSpec, FilterValue } from "../filter-builder/types.js";

/** A value a property holds on its own, outside a list or a group. */
export type PropertyScalar = string | number | boolean | null;

/** What is known about a property: what a type declares for it, or what records hold for it. */
export interface PropertyInfo {
  readonly name: string;
  /** `group` is a value with named parts of its own; `list` is several values. */
  readonly kind: "text" | "number" | "boolean" | "list" | "group" | "other";
  /** The values the property may take, when they are listed. */
  readonly options?: readonly PropertyScalar[] | undefined;
  /** `date` or `date-time`, when that is known. */
  readonly format?: string | undefined;
  /** The record is not valid without it: its row is always shown and it cannot be taken off. */
  readonly required?: boolean | undefined;
  /** What the property is for, in the type's words. */
  readonly description?: string | undefined;
  /** The parts a group names, in the type's order. */
  readonly parts?: readonly PropertyInfo[] | undefined;
  /** What a part the group does not name holds, or false when it may hold no such part. */
  readonly rest?: PropertyInfo | false | undefined;
  /** What each value of a list is, when that is known. Its name is not used. */
  readonly items?: PropertyInfo | undefined;
  /** The property links to other records: to one, or to several. */
  readonly link?: { readonly many: boolean } | undefined;
}

/**
 * How a property is shown and edited. A `group` and a list of `items` are shown part by part,
 * each part with the control its own value calls for.
 */
export type PropertyKind = "choice" | "boolean" | "date" | "datetime" | "number" | "tags" | "links" | "text" | "long" | "group" | "items" | "other";

const wholeLink = /^!?\[\[[^\]]+\]\]$/u;
const day = /^\d{4}-\d{2}-\d{2}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
const dateTime = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}\S*$/u;
const word = /^[\p{L}\p{N}_-]{1,24}$/u;
const name = /^[A-Za-z_][A-Za-z0-9_:-]*$/u;
/** How many different values a property may have and still be offered as a choice. */
const fewValues = 12;

export const isLink = (value: unknown): value is string => typeof value === "string" && wholeLink.test(value.trim());
export const isScalar = (value: unknown): value is PropertyScalar => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
export const isGroup = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether text can name a property: letters, digits, `-`, `_` and `:`, not starting with a digit. */
export const isPropertyName = (text: string): boolean => name.test(text);

/** Whether a property holds nothing: it is absent, null, empty text, or a list or group of nothing. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isGroup(value) && Object.keys(value).length === 0;
}

/** Text someone typed as the value it most plainly means. */
export function parseValue(text: string): PropertyScalar {
  const typed = text.trim();
  if (typed === "null") return null;
  if (typed === "true") return true;
  if (typed === "false") return false;
  return /^-?\d+(\.\d+)?$/u.test(typed) ? Number(typed) : typed;
}

/** What a value is, going by what it holds first and by what is known of the property when it holds nothing. */
export function propertyKind(value: unknown, info: PropertyInfo | undefined): PropertyKind {
  const unset = value === undefined || value === null || value === "";
  // A property declared as a link is one whenever its value has the shape links are written in.
  if (info?.link && (unset || typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string")))) return "links";
  if (Array.isArray(value) ? value.length > 0 && value.every(isLink) : isLink(value)) return "links";
  if (isGroup(value)) return "group";
  if (info?.options?.length && (unset || isScalar(value))) return "choice";
  if (typeof value === "boolean" || (unset && info?.kind === "boolean")) return "boolean";
  if (Array.isArray(value)) return !partedItems(info) && value.every((item) => typeof item === "string" || typeof item === "number") ? "tags" : "items";
  // One value where the type says a list of short ones is that list's first.
  if (!unset && info?.kind === "list" && !partedItems(info) && (typeof value === "string" || typeof value === "number")) return "tags";
  if (unset && info?.kind === "list") return partedItems(info) ? "items" : "tags";
  if (unset && info?.kind === "group") return "group";
  // Text where the type says a number, or the other way about, is edited as the type says: what is typed puts it right.
  if (typeof value === "string" && info?.kind === "number") return "number";
  if (typeof value === "number" && info?.kind === "text") return "text";
  if (typeof value === "number" || (unset && info?.kind === "number")) return "number";
  if (typeof value === "string") {
    if (info?.format === "date" ? day.test(value) : !info && day.test(value)) return "date";
    // Only a declared moment is edited as one: writing it back puts it in UTC, which a type that says so expects.
    if (info?.format === "date-time" && localMoment(value)) return "datetime";
    return value.includes("\n") || value.length > 90 ? "long" : "text";
  }
  if (unset) return info?.format === "date" ? "date" : info?.format === "date-time" ? "datetime" : "text";
  return "other";
}

/** A moment as a `datetime-local` field holds it: the reader's own date and time, to the second. Empty when the text is not a moment. */
export function localMoment(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value)) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

/** The moment a `datetime-local` field holds, as it is stored: in UTC. Null when the field holds none. */
export function storedMoment(local: string): string | null {
  const at = new Date(local);
  return local === "" || Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Whether a list's values are known to be more than short text or numbers: they are then shown one by one. */
function partedItems(info: PropertyInfo | undefined): boolean {
  const kind = info?.items?.kind;
  return kind !== undefined && kind !== "text" && kind !== "number";
}

/**
 * What a property holds when it is first given a place: nothing, or for a value with parts the
 * parts it must have, each as blank as its kind allows.
 */
export function blankValue(info: PropertyInfo | undefined): unknown {
  if (!info || info.options?.length || info.link) return null;
  if (info.kind === "group") {
    const parts: [string, unknown][] = [];
    for (const part of info.parts ?? []) {
      const blank = part.required ? blankValue(part) : null;
      if (blank !== null) parts.push([part.name, blank]);
    }
    return Object.fromEntries(parts);
  }
  if (info.kind === "list") return [];
  if (info.kind === "boolean") return false;
  return info.kind === "text" && !info.format ? "" : null;
}

/** How many values a value holds once its lists and groups are opened up, counted no further than `limit`. */
export function valueCount(value: unknown, limit = 64): number {
  if (Array.isArray(value) || isGroup(value)) {
    let count = 0;
    for (const inner of Array.isArray(value) ? value : Object.values(value)) {
      count += valueCount(inner, limit - count);
      if (count >= limit) return limit;
    }
    return count;
  }
  return 1;
}

/**
 * What is known about a property: what the record's type declares, or failing that what other
 * records hold for it, or what a group says of the parts it does not name.
 */
export function describeProperty(
  property: string,
  declared: readonly PropertyInfo[],
  inUse: readonly PropertyInfo[],
  unnamed?: PropertyInfo | false | undefined,
): { info: PropertyInfo | undefined; suggestions: readonly string[] | undefined; own: boolean } {
  const own = declared.find((field) => field.name === property);
  if (own) return { info: own, suggestions: undefined, own: true };
  const seen = inUse.find((field) => field.name === property);
  if (!seen) return { info: unnamed ? { ...unnamed, name: property } : undefined, suggestions: undefined, own: false };
  // Values other records happen to hold are worth offering, but they are not all the property may hold.
  const { options, ...rest } = seen;
  return { info: rest, suggestions: options?.filter((option): option is string => typeof option === "string"), own: false };
}

/** `[[sources/crime|Crime]]`, `[[sources/crime#p3]]` or a bare path, as a collection path. */
export function linkToPath(link: string): string | null {
  const text = link.trim();
  const wiki = /^!?\[\[([^\]]*)\]\]$/u.exec(text);
  const target = (wiki ? wiki[1]! : text).split("|")[0]!.split("#")[0]!.trim().replace(/^\/+/u, "");
  if (!target || /[[\]]/u.test(target)) return null;
  return /\.[A-Za-z0-9]{1,8}$/u.test(target) ? target : `${target}.md`;
}

/** A record's path as the wikilink that is rewritten when the record is renamed. */
export function pathToLink(path: string): string {
  return `[[${path.replace(/\.md$/u, "")}]]`;
}

function pathStem(path: string): string {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/** `[[sources/crime|Crime and Punishment]]` as "Crime and Punishment". Other text is left alone. */
export function linkLabel(value: string): string {
  return value.replace(/!?\[\[([^\]]+)\]\]/gu, (_all, inner: string) => {
    const [target = "", alias] = inner.split("|");
    return (alias ?? pathStem(target.split("#")[0]!)).trim();
  });
}

/**
 * What a link is called while its record is not known: the name it gives, or failing that the
 * last part of where it leads. Reads a wikilink, a Markdown link and a bare path.
 */
export function linkName(link: string): string {
  const text = link.trim();
  if (wholeLink.test(text)) return linkLabel(text);
  const markdown = /^!?\[([^\]]*)\]\(<?([^)>]*)>?\)$/u.exec(text);
  if (markdown) return markdown[1]!.trim() || pathStem(markdown[2]!);
  return pathStem(text) || text;
}

/** A value as one short line of text, or undefined when it does not fit on one. */
export function valueLine(value: unknown, words: { readonly yes: string; readonly no: string }): string | undefined {
  if (typeof value === "string") {
    const text = linkLabel(value.trim()).replace(dateTime, "$1");
    return text && text.length <= 80 && !text.includes("\n") ? text : undefined;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? words.yes : words.no;
  if (Array.isArray(value) && value.length && value.length <= 6 && value.every((item) => typeof item === "string")) {
    const text = (value as string[]).map((item) => linkLabel(item)).join(", ");
    return text.length <= 80 ? text : undefined;
  }
  return undefined;
}

/** What a property is, going by the values records hold for it. Undefined when there are none. */
export function inferProperty(property: string, values: readonly unknown[]): PropertyInfo | undefined {
  if (!values.length) return undefined;
  if (values.every((value) => typeof value === "boolean")) return { name: property, kind: "boolean" };
  if (values.every((value) => typeof value === "number")) return { name: property, kind: "number" };
  if (values.every((value) => Array.isArray(value))) return { name: property, kind: "list" };
  if (!values.every((value): value is string => typeof value === "string")) return { name: property, kind: "other" };
  if (values.every((value) => wholeLink.test(value.trim()))) return { name: property, kind: "other" };
  if (values.every((value) => day.test(value))) return { name: property, kind: "text", format: "date" };
  if (values.every((value) => instant.test(value))) return { name: property, kind: "text", format: "date-time" };
  const distinct = [...new Set(values)];
  // A handful of short values, or values that repeat, read as a set to choose from.
  const choice = distinct.length <= fewValues && (distinct.every((value) => word.test(value)) || distinct.length * 2 <= values.length);
  return choice ? { name: property, kind: "text", options: distinct.sort((a, b) => a.localeCompare(b)) } : { name: property, kind: "text" };
}

/**
 * The properties to offer for a set of records: the declared ones first, in their order, then
 * whatever else the records hold, each described by the values held for it. `skip` leaves a
 * name out of what is inferred, as for the properties that are an app's own machinery.
 */
export function propertiesInUse(
  records: Iterable<Readonly<Record<string, unknown>>>,
  declared: readonly PropertyInfo[] = [],
  skip: (property: string) => boolean = () => false,
): PropertyInfo[] {
  const out = new Map<string, PropertyInfo>();
  for (const field of declared) {
    if (!out.has(field.name)) out.set(field.name, field);
  }
  const found = new Map<string, unknown[]>();
  for (const record of records) {
    for (const [property, value] of Object.entries(record)) {
      if (out.has(property) || value === null || value === undefined || value === "" || !name.test(property) || skip(property)) continue;
      const values = found.get(property);
      if (values) values.push(value);
      else found.set(property, [value]);
    }
  }
  for (const [property, values] of found) {
    const field = inferProperty(property, values);
    if (field) out.set(property, field);
  }
  return [...out.values()];
}

/** Properties as the filter builder's fields, by name: those whose values can be compared. */
export function filterFieldsFromProperties(properties: readonly PropertyInfo[]): FilterFieldSpec[] {
  const out: FilterFieldSpec[] = [];
  for (const field of properties) {
    if (!name.test(field.name)) continue;
    const values = field.options?.filter((option): option is FilterValue => option !== null);
    if (values?.length) out.push({ key: field.name, kind: "enum", enumValues: values });
    else if (field.kind === "number" || field.kind === "boolean") out.push({ key: field.name, kind: field.kind });
    else if (field.kind === "text") out.push({ key: field.name, kind: field.format === "date" || field.format === "date-time" ? "date" : "string" });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
