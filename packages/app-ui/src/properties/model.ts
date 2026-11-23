import type { FilterFieldSpec, FilterValue } from "../filter-builder/types.js";

/** A value a property holds on its own, outside a list or a group. */
export type PropertyScalar = string | number | boolean | null;

/** What is known about a property: what a type declares for it, or what records hold for it. */
export interface PropertyInfo {
  readonly name: string;
  readonly kind: "text" | "number" | "boolean" | "list" | "other";
  /** The values the property may take, when they are listed. */
  readonly options?: readonly PropertyScalar[] | undefined;
  /** `date` or `date-time`, when that is known. */
  readonly format?: string | undefined;
}

/** How a property is shown and edited. */
export type PropertyKind = "choice" | "boolean" | "date" | "number" | "tags" | "links" | "text" | "long" | "other";

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
  if (Array.isArray(value) ? value.length > 0 && value.every(isLink) : isLink(value)) return "links";
  if (info?.options?.length && (unset || isScalar(value))) return "choice";
  if (typeof value === "boolean" || (unset && info?.kind === "boolean")) return "boolean";
  if (Array.isArray(value)) return value.every((item) => typeof item === "string" || typeof item === "number") ? "tags" : "other";
  if (unset && info?.kind === "list") return "tags";
  if (typeof value === "number" || (unset && info?.kind === "number")) return "number";
  if (typeof value === "string") {
    if (info?.format === "date" ? day.test(value) : !info && day.test(value)) return "date";
    return value.includes("\n") || value.length > 90 ? "long" : "text";
  }
  if (unset) return info?.format === "date" ? "date" : "text";
  return "other";
}

/** What is known about a property: what the record's type declares, or failing that what other records hold for it. */
export function describeProperty(
  property: string,
  declared: readonly PropertyInfo[],
  inUse: readonly PropertyInfo[],
): { info: PropertyInfo | undefined; suggestions: readonly string[] | undefined; own: boolean } {
  const own = declared.find((field) => field.name === property);
  if (own) return { info: own, suggestions: undefined, own: true };
  const seen = inUse.find((field) => field.name === property);
  if (!seen) return { info: undefined, suggestions: undefined, own: false };
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
