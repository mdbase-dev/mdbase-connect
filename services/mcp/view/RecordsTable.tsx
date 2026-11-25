import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { PropertyKindIcon, propertiesInUse, propertyKind, propertyLabels, valueLine, type PropertyInfo } from "@mdbase-dev/ui/properties";
import { useMemo, useState, type JSX } from "react";
import type { Groups, Records, Row } from "./model";
import { recordTitle } from "./model";

/** Query results: one row per record, opened by its name, and the next page on request. */
export function RecordsTable({ shown, onOpen, onMore }: {
  readonly shown: Records;
  readonly onOpen: (row: Row) => void;
  /** Loads the next page; resolves once it is shown or has failed. */
  readonly onMore: () => Promise<void>;
}): JSX.Element {
  useLingui();
  const [loading, setLoading] = useState(false);
  const described = useMemo(() => new Map(propertiesInUse(shown.rows.map((row) => row.cells)).map((info) => [info.name, info])), [shown.rows]);
  const words = propertyLabels();
  if (!shown.rows.length) return <p className="view-empty">{t`No records match.`}</p>;
  const count = shown.rows.length;
  const total = shown.total;
  return <section className="view-records" aria-label={t({ message: "Records", context: "Label of the query results table" })}>
    <div className="view-table-scroll">
      <table className="view-table">
        <thead>
          <tr>
            <th scope="col">{t({ message: "Name", context: "Column of record names" })}</th>
            {shown.columns.map((column) => <th scope="col" key={column.key}>
              <span className="view-column">
                <ColumnIcon info={described.get(column.key)} rows={shown.rows} column={column.key} />
                {column.label}
              </span>
            </th>)}
          </tr>
        </thead>
        <tbody>
          {shown.rows.map((row) => <tr key={row.path}>
            <th scope="row">
              <button type="button" className="view-open" title={row.path} onClick={() => onOpen(row)}>
                {recordTitle({ frontmatter: row.frontmatter, name: row.name })}
              </button>
            </th>
            {shown.columns.map((column) => <td key={column.key}>{cell(row.cells[column.key], words)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <footer className="view-records-foot">
      <span className="view-muted">{total !== undefined && total > count
        ? t`${count} of ${total} records`
        : plural(count, { one: "# record", other: "# records" })}</span>
      {shown.cursor && <button
        type="button"
        className="mdbase-button"
        aria-busy={loading}
        disabled={loading}
        onClick={() => {
          setLoading(true);
          void onMore().finally(() => setLoading(false));
        }}
      ><span className="mdbase-button-label">{t({ message: "Load more", context: "Loads the next page of query results" })}</span></button>}
    </footer>
  </section>;
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
          {shown.columns.map((column) => <td key={column.key}>{cell(group.values[column.key] ?? group.summaries[column.key], words)}</td>)}
          <td>{group.count}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function ColumnIcon({ info, rows, column }: { readonly info: PropertyInfo | undefined; readonly rows: readonly Row[]; readonly column: string }): JSX.Element | null {
  const sample = rows.find((row) => row.cells[column] !== undefined && row.cells[column] !== null)?.cells[column];
  if (sample === undefined) return null;
  return <PropertyKindIcon kind={propertyKind(sample, info)} size={13} />;
}

/** A cell's value on one line, as the property list shows a value it only shows. */
function cell(value: unknown, words: { readonly yes: string; readonly no: string }): string {
  if (value === undefined || value === null || value === "") return "";
  return valueLine(value, words) ?? (typeof value === "string" ? `${value.split("\n")[0]!.slice(0, 80)}…` : JSON.stringify(value).slice(0, 80));
}
