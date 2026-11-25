// What the gateway's tool results mean to the view. The shapes are the gateway's own
// (src/next-mapping.ts and src/mcp.ts); anything else is shown as unsupported, never guessed at.

export type Json = Record<string, unknown>;

/** A record as read_record and the record write tools return it. */
export interface RecordDocument {
  readonly path: string;
  readonly revision: string;
  readonly types: readonly string[];
  readonly frontmatter: Json;
  readonly body: string;
  readonly name: string;
}

export interface Row {
  readonly path: string;
  readonly name: string;
  readonly types: readonly string[];
  /** What each column shows for the row, by column key. */
  readonly cells: Json;
  /** All the row's own frontmatter, for describing columns. Empty for metadata output. */
  readonly frontmatter: Json;
}

export interface Column {
  readonly key: string;
  readonly label: string;
}

export interface Records {
  readonly kind: "records";
  readonly rows: readonly Row[];
  readonly columns: readonly Column[];
  readonly cursor: string | undefined;
  readonly total: number | undefined;
}

export interface Groups {
  readonly kind: "groups";
  readonly columns: readonly Column[];
  readonly groups: readonly { readonly values: Json; readonly count: number; readonly summaries: Json }[];
}

export type Shown =
  | { readonly kind: "record"; readonly record: RecordDocument; readonly renamedFrom: string | undefined }
  | Records
  | Groups
  | { readonly kind: "error"; readonly code: string; readonly message: string; readonly link: string | undefined }
  | { readonly kind: "unsupported" };

/** The most columns a table shows when the query did not choose them. */
const IMPLICIT_COLUMNS = 6;

/**
 * What a tool result shows. `args` are the arguments the tool was called with: a query's `select`
 * names its columns.
 */
export function shownResult(result: { structuredContent?: unknown; isError?: boolean }, args: Json = {}): Shown {
  const content = isObject(result.structuredContent) ? result.structuredContent : undefined;
  if (!content) return { kind: "unsupported" };
  if (result.isError || isObject(content.error)) return errorOf(content.error);
  // Writes wrap the record in a receipt; a delete's outcome is not a record.
  const value = isObject(content.mutation_receipt) ? content.outcome : content;
  if (!isObject(value)) return { kind: "unsupported" };
  const record = recordDocument(value);
  if (record) return { kind: "record", record, renamedFrom: typeof value.from === "string" && value.from !== record.path ? value.from : undefined };
  if (Array.isArray(value.results) && isObject(value.meta)) return queryResult(value.results, value.meta, args);
  return { kind: "unsupported" };
}

export function recordDocument(value: Json): RecordDocument | undefined {
  if (typeof value.path !== "string" || typeof value.revision !== "string" || !isObject(value.frontmatter)) return undefined;
  return {
    path: value.path,
    revision: value.revision,
    types: stringList(value.types),
    frontmatter: value.frontmatter,
    body: typeof value.body === "string" ? value.body : "",
    name: fileName(value),
  };
}

/** The next page's rows after `page`, with `page`'s columns kept and any new ones added. */
export function appendPage(shown: Records, page: Shown): Records | undefined {
  if (page.kind !== "records") return undefined;
  const keys = new Set(shown.columns.map((column) => column.key));
  return {
    ...page,
    rows: [...shown.rows, ...page.rows],
    columns: [...shown.columns, ...page.columns.filter((column) => !keys.has(column.key))],
  };
}

/** A title for a record: the `title` property when it has one, else its file name. */
export function recordTitle(record: { readonly frontmatter: Json; readonly name: string }): string {
  const title = record.frontmatter.title;
  return typeof title === "string" && title.trim() ? title.trim() : record.name;
}

function queryResult(results: unknown[], meta: Json, args: Json): Records | Groups {
  const selected = selectedColumns(args.select);
  if (!results.length && Array.isArray(meta.groups) && meta.groups.length) {
    const groups = meta.groups.filter(isObject).map((group) => ({
      values: isObject(group.values) ? group.values : {},
      count: typeof group.count === "number" ? group.count : 0,
      summaries: isObject(group.summaries) ? group.summaries : {},
    }));
    const keys = unique(groups.flatMap((group) => [...Object.keys(group.values), ...Object.keys(group.summaries)]));
    return { kind: "groups", groups, columns: keys.map((key) => ({ key, label: key })) };
  }
  const rows = results.filter(isObject).flatMap((result): Row[] => {
    if (typeof result.path !== "string") return [];
    const frontmatter = isObject(result.frontmatter) ? result.frontmatter : {};
    const values = isObject(result.values) ? result.values : {};
    return [{
      path: result.path,
      name: fileName(result),
      types: stringList(result.types),
      frontmatter,
      cells: selected ? Object.fromEntries(selected.map((column) => [column.key, values[column.key] ?? frontmatter[column.key]])) : frontmatter,
    }];
  });
  const columns = selected ?? unique(rows.flatMap((row) => Object.keys(row.frontmatter)))
    .filter((key) => key !== "title")
    .slice(0, IMPLICIT_COLUMNS)
    .map((key) => ({ key, label: key }));
  return {
    kind: "records",
    rows,
    columns,
    cursor: meta.has_more === true && typeof meta.cursor === "string" ? meta.cursor : undefined,
    total: typeof meta.total_count === "number" ? meta.total_count : undefined,
  };
}

/** A query's `select`, as columns: a field name, or `{ name, label }` for a computed one. */
function selectedColumns(select: unknown): Column[] | undefined {
  if (!Array.isArray(select) || !select.length) return undefined;
  return select.flatMap((entry): Column[] => {
    if (typeof entry === "string") return [{ key: entry, label: entry }];
    if (isObject(entry) && typeof entry.name === "string") {
      return [{ key: entry.name, label: typeof entry.label === "string" && entry.label ? entry.label : entry.name }];
    }
    return [];
  }).filter((column) => column.key !== "title" && column.key !== "file.name" && column.key !== "file.path");
}

function errorOf(error: unknown): Shown {
  const value = isObject(error) ? error : {};
  const details = isObject(value.details) ? value.details : {};
  return {
    kind: "error",
    code: typeof value.code === "string" ? value.code : "operation_failed",
    message: typeof value.message === "string" ? value.message : "",
    link: typeof details.authorization_url === "string" ? details.authorization_url : undefined,
  };
}

function fileName(value: Json): string {
  const file = isObject(value.file) ? value.file : {};
  if (typeof file.name === "string" && file.name) return file.name;
  const path = typeof value.path === "string" ? value.path : "";
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/u, "");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(keys: string[]): string[] {
  return [...new Set(keys)];
}

export function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
