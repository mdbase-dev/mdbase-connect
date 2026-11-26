import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
  mergeTypeSchemas, PropertyKindIcon, propertiesFromSchema, propertiesInUse, propertyKind, propertyLabels, PropertyValue, valueLine, type PropertyInfo, type PropertyKind
} from "@mdbase-dev/ui/properties";
import { useMemo, useRef, useState, type JSX } from "react";
import { schemasOf, useCollection, type Collection } from "./collection";
import type { Host } from "./host";
import { recordTitle, rowAfter, sortOf, typeOfResults, type Column, type Groups, type Json, type Records, type Row } from "./model";

/** The name column sorts by the file name. */
const NAME_FIELD = "file.name";

/**
 * Query results: one row per record, opened by its name. Field columns sort the query on a click
 * and, where the connection may update records, hold controls that change a value in place, one
 * update_record against the row's revision; the next page comes on request, and a new record of the results' type is made
 * from the footer.
 */
export function RecordsTable({ host, connectionId, args, shown, onOpen, onMore, onSort, onRow, onCreate }: {
  readonly host: Host;
  readonly connectionId: string;
  /** The query's arguments: what it is ordered by, and the type a new record would be. */
  readonly args: Json;
  readonly shown: Records;
  readonly onOpen: (row: Row) => void;
  /** Loads the next page; resolves once it is shown or has failed. */
  readonly onMore: () => Promise<void>;
  /** Asks again ordered by a field; resolves once the results are shown or have failed. */
  readonly onSort: (field: string) => Promise<void>;
  /** A row changed here, optimistically or as saved. */
  readonly onRow: (row: Row) => void;
  readonly onCreate: (type: string) => void;
}): JSX.Element {
  useLingui();
  const collection = useCollection(host, connectionId);
  const [loading, setLoading] = useState<"more" | "sort" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Each row as last shown or saved, for the revision the next change is made against. */
  const latest = useRef(new Map<string, Row>());
  for (const row of shown.rows) latest.current.set(row.path, row);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const inUse = useMemo(() => new Map(propertiesInUse(shown.rows.map((row) => row.cells)).map((info) => [info.name, info])), [shown.rows]);
  const declared = useDeclared(collection);
  const words = propertyLabels();
  const sort = sortOf(args);
  const type = collection?.creatable ? typeOfResults(args, shown.rows) : undefined;
  const editable = collection?.editable === true;

  function busy(kind: "more" | "sort", work: Promise<void>): void {
    setLoading(kind);
    void work.finally(() => setLoading(null));
  }

  function info(row: Row, key: string): PropertyInfo | undefined {
    return declared(row.types).find((field) => field.name === key) ?? inUse.get(key);
  }

  /**
   * One value saved after the changes before it, against the row's latest revision. A refusal puts
   * back only this value.
   */
  function save(row: Row, key: string, value: unknown): void {
    setProblem(null);
    const was = row.cells[key];
    onRow({ ...row, cells: { ...row.cells, [key]: value ?? undefined } });
    saving.current = saving.current.then(async () => {
      const before = latest.current.get(row.path)!;
      const result = await host.show("update_record", {
        connection_id: connectionId, path: before.path, if_revision: before.revision,
        ...(value === null ? { unset: [key] } : { patch: { [key]: value } }),
      });
      if (result.kind !== "record") {
        const current = latest.current.get(row.path)!;
        onRow({ ...current, cells: { ...current.cells, [key]: was } });
        setProblem(result.kind === "error" && result.message ? result.message : t`The change could not be saved.`);
        return;
      }
      const after = rowAfter(before, shown.columns, result.record);
      latest.current.set(row.path, after);
      onRow(after);
      host.tell(value === null
        ? `In the mdbase view the user removed "${key}" from ${result.record.path}; its revision is now ${result.record.revision}.`
        : `In the mdbase view the user set "${key}" on ${result.record.path} to ${JSON.stringify(value)}; its revision is now ${result.record.revision}.`);
    });
  }

  const count = shown.rows.length;
  const total = shown.total;
  return <section className="view-records" aria-label={t({ message: "Records", context: "Label of the query results table" })} aria-busy={loading === "sort"}>
    {problem && <div className="view-problem" role="alert"><span>{problem}</span></div>}
    {count === 0
      ? <p className="view-empty">{t`No records match.`}</p>
      : <div className="view-table-scroll">
        <table className="view-table">
          <thead>
            <tr>
              <SortHeader field={NAME_FIELD} sort={sort} disabled={loading !== null} onSort={(field) => busy("sort", onSort(field))}>
                {t({ message: "Name", context: "Column of record names" })}
              </SortHeader>
              {shown.columns.map((column) => <SortHeader
                key={column.key}
                field={column.field ? column.key : undefined}
                sort={sort}
                disabled={loading !== null}
                onSort={(field) => busy("sort", onSort(field))}
              >
                <span className="view-column">
                  <ColumnIcon info={inUse.get(column.key)} rows={shown.rows} column={column.key} />
                  {column.label}
                </span>
              </SortHeader>)}
            </tr>
          </thead>
          <tbody>
            {shown.rows.map((row) => <tr key={row.path}>
              <th scope="row">
                <button type="button" className="view-open" title={row.path} onClick={() => onOpen(row)}>
                  {recordTitle({ frontmatter: row.frontmatter, name: row.name })}
                </button>
              </th>
              {shown.columns.map((column) => <Cell
                key={column.key}
                row={row}
                column={column}
                info={info(row, column.key)}
                words={words}
                editable={editable && column.field && row.revision !== undefined}
                onChange={(value) => save(row, column.key, value)}
              />)}
            </tr>)}
          </tbody>
        </table>
      </div>}
    <footer className="view-records-foot">
      <span className="view-muted">{total !== undefined && total > count
        ? t`${count} of ${total} records`
        : plural(count, { one: "# record", other: "# records" })}</span>
      <span className="view-records-actions">
        {type && <button type="button" className="mdbase-button is-tertiary" onClick={() => onCreate(type)}>
          <span className="mdbase-button-label">{t({ message: `New ${type}`, context: "Makes a new record of the type the results show" })}</span>
        </button>}
        {shown.cursor && <button
          type="button"
          className="mdbase-button"
          aria-busy={loading === "more"}
          disabled={loading !== null}
          onClick={() => busy("more", onMore())}
        ><span className="mdbase-button-label">{t({ message: "Load more", context: "Loads the next page of query results" })}</span></button>}
      </span>
    </footer>
  </section>;
}

/** A column heading: a button that orders the query by its field, when it is one. */
function SortHeader({ field, sort, disabled, onSort, children }: {
  readonly field: string | undefined;
  readonly sort: ReturnType<typeof sortOf>;
  readonly disabled: boolean;
  readonly onSort: (field: string) => void;
  readonly children: JSX.Element | string;
}): JSX.Element {
  const direction = field !== undefined && sort?.field === field ? sort.direction : undefined;
  if (field === undefined) return <th scope="col">{children}</th>;
  return <th scope="col" aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : undefined}>
    <button type="button" className="view-sort" disabled={disabled} onClick={() => onSort(field)}>
      {children}
      <span className="view-sort-mark" aria-hidden="true">{direction === "desc" ? "↓" : direction === "asc" ? "↑" : ""}</span>
    </button>
  </th>;
}

/** The kinds of value a cell changes in place; a list or a link is changed in the record's card. */
const INLINE = new Set<PropertyKind>(["choice", "boolean", "date", "datetime", "number", "text"]);

/**
 * A value on one line. A field the connection may change holds the property list's own control,
 * which reads as text until it is used.
 */
function Cell({ row, column, info, words, editable, onChange }: {
  readonly row: Row;
  readonly column: Column;
  readonly info: PropertyInfo | undefined;
  readonly words: { readonly yes: string; readonly no: string };
  readonly editable: boolean;
  readonly onChange: (value: unknown) => void;
}): JSX.Element {
  const value = row.cells[column.key];
  const kind = propertyKind(value, info);
  if (!editable || !INLINE.has(kind)) return <td>{line(value, words)}</td>;
  return <td className="view-edit-cell">
    <div className="mdbase-property-value">
      <PropertyValue name={column.label} value={value} info={info} kind={kind} onChange={onChange} />
    </div>
  </td>;
}

function ColumnIcon({ info, rows, column }: { readonly info: PropertyInfo | undefined; readonly rows: readonly Row[]; readonly column: string }): JSX.Element | null {
  const sample = rows.find((row) => row.cells[column] !== undefined && row.cells[column] !== null)?.cells[column];
  if (sample === undefined) return null;
  return <PropertyKindIcon kind={propertyKind(sample, info)} size={13} />;
}

/** The properties each set of types declares, worked out once per set. */
function useDeclared(collection: Collection | null): (types: readonly string[]) => readonly PropertyInfo[] {
  return useMemo(() => {
    const known = new Map<string, readonly PropertyInfo[]>();
    return (types) => {
      if (!collection) return [];
      const key = types.join("\n");
      let found = known.get(key);
      if (!found) {
        const { properties, required } = mergeTypeSchemas(schemasOf(collection, types));
        found = propertiesFromSchema(properties, required);
        known.set(key, found);
      }
      return found;
    };
  }, [collection]);
}

/** Grouped results with no records of their own: each group's values, count and summaries. */
export function GroupsTable({ shown }: { readonly shown: Groups }): JSX.Element {
  useLingui();
  const words = propertyLabels();
  return <div className="view-table-scroll">
    <table className="view-table">
      <thead>
        <tr>
          {shown.columns.map((column) => <th scope="col" key={column.key}>{column.label}</th>)}
          <th scope="col">{t({ message: "Count", context: "Column of how many records a group holds" })}</th>
        </tr>
      </thead>
      <tbody>
        {shown.groups.map((group, index) => <tr key={index}>
          {shown.columns.map((column) => <td key={column.key}>{line(group.values[column.key] ?? group.summaries[column.key], words)}</td>)}
          <td>{group.count}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

/** A value on one line, as the property list shows a value it only shows. */
function line(value: unknown, words: { readonly yes: string; readonly no: string }): string {
  if (value === undefined || value === null || value === "") return "";
  return valueLine(value, words) ?? (typeof value === "string" ? `${value.split("\n")[0]!.slice(0, 80)}…` : JSON.stringify(value).slice(0, 80));
}
