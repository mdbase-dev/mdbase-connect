import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { useMdbaseMarkActivity } from "@mdbase-dev/ui/mark-activity";
import { OpeningScreen } from "@mdbase-dev/ui/screens";
import { useRef, useState, type JSX } from "react";
import { editorRecordLink, useCollection, useEditorLink } from "./collection";
import type { Host } from "./host";
import { appendPage, rowAfter, rowOf, sortedBy, type Changes, type Json, type RecordDocument, type Row, type Shown } from "./model";
import { NewRecord } from "./NewRecord";
import { RecordCard } from "./RecordCard";
import { GroupsTable, RecordsTable } from "./RecordsTable";

/** What one screen of the view shows, and the call that produced it. */
export interface Screen {
  readonly id: number;
  readonly connectionId: string;
  readonly args: Json;
  readonly shown: Shown | { readonly kind: "loading"; readonly title: string } | { readonly kind: "new"; readonly type: string };
  /** Whether a record starts unfolded: one the person opened, rather than one the model read. */
  readonly open?: boolean | undefined;
  /** What the model's update changed in the record shown. */
  readonly changes?: Changes | undefined;
}

/** How the host is showing the view: whether it fills the screen, and whether it could. */
export interface Display {
  readonly full: boolean;
  readonly canFill: boolean;
}

/**
 * The view a tool call opens: query results or a record. Opening a record, or making one, shows
 * it in place, with a way back to the results.
 */
export function View({ host, first, display }: { readonly host: Host; readonly first: Screen; readonly display: Display }): JSX.Element {
  useLingui();
  const [stack, setStack] = useState<readonly Screen[]>([first]);
  const ids = useRef(first.id);
  const screen = stack[stack.length - 1]!;
  const push = (next: Omit<Screen, "id">): Screen => {
    const pushed = { ...next, id: ++ids.current };
    setStack((current) => [...current, pushed]);
    return pushed;
  };
  /** Changes one screen, wherever it is in the stack now; one Back has taken away is left gone. */
  const change = (id: number, next: (screen: Screen) => Screen) => setStack((current) => current.map((item) => item.id === id ? next(item) : item));
  const back = () => setStack((current) => current.slice(0, -1));

  function open(path: string, title: string): void {
    const args = { connection_id: screen.connectionId, path };
    const loading = push({ connectionId: screen.connectionId, args, shown: { kind: "loading", title }, open: true });
    void host.show("read_record", args).then((shown) => change(loading.id, (item) => ({ ...item, shown })));
  }

  async function more(): Promise<void> {
    const from = screen;
    if (from.shown.kind !== "records" || !from.shown.cursor) return;
    const page = await host.show("query_records", { ...from.args, cursor: from.shown.cursor });
    // The page goes to the results it extends, even if a record was opened while it loaded.
    change(from.id, (item) => item.shown.kind === "records" ? { ...item, shown: appendPage(item.shown, page) ?? page } : item);
  }

  async function sort(field: string): Promise<void> {
    const from = screen;
    const args = sortedBy(from.args, field);
    const shown = await host.show("query_records", args);
    change(from.id, (item) => ({ ...item, args, shown }));
  }

  /** A row the table changed, in the results it belongs to. */
  function setRow(id: number, row: Row): void {
    change(id, (item) => item.shown.kind === "records"
      ? { ...item, shown: { ...item.shown, rows: item.shown.rows.map((each) => each.path === row.path ? row : each) } }
      : item);
  }

  /** A record saved in a card, in every set of results that shows it. */
  function saved(record: RecordDocument): void {
    setStack((current) => current.map((item) => {
      if (item.shown.kind !== "records") return item;
      const results = item.shown;
      return { ...item, shown: { ...results, rows: results.rows.map((row) => row.path === record.path ? rowAfter(row, results.columns, record) : row) } };
    }));
  }

  /** A record made here: shown in place of the form, and first in the results it was made from. */
  function created(id: number, record: RecordDocument): void {
    setStack((current) => current.map((item, index) => {
      if (item.id === id) return { ...item, args: { connection_id: item.connectionId, path: record.path }, shown: { kind: "record", record, renamedFrom: undefined }, open: true };
      const above = current[index + 1];
      return above?.id === id && item.shown.kind === "records"
        ? { ...item, shown: { ...item.shown, rows: [rowOf(record, item.shown.columns), ...item.shown.rows] } }
        : item;
    }));
  }

  const shown = screen.shown;
  return <div className={display.full ? "view is-full" : "view"}>
    <ViewHeader
      host={host}
      connectionId={screen.connectionId}
      recordPath={shown.kind === "record" ? shown.record.path : undefined}
      display={display}
      onBack={stack.length > 1 ? back : undefined}
    />
    {shown.kind === "loading" && <OpeningScreen app={{ name: "mdbase" }} layout="panel" title={t`Opening ${shown.title}`} />}
    {shown.kind === "records" && <RecordsTable
      host={host}
      connectionId={screen.connectionId}
      args={screen.args}
      shown={shown}
      onOpen={(row) => open(row.path, row.name)}
      onMore={more}
      onSort={sort}
      onRow={(row) => setRow(screen.id, row)}
      onCreate={(type) => push({ connectionId: screen.connectionId, args: {}, shown: { kind: "new", type } })}
    />}
    {shown.kind === "groups" && <GroupsTable shown={shown} />}
    {shown.kind === "record" && <RecordCard
      key={screen.id}
      host={host}
      connectionId={screen.connectionId}
      record={shown.record}
      renamedFrom={shown.renamedFrom}
      changes={screen.changes}
      open={screen.open === true}
      full={display.full}
      onOpen={(path) => open(path, path)}
      onSaved={saved}
    />}
    {shown.kind === "new" && <NewRecord
      host={host}
      connectionId={screen.connectionId}
      type={shown.type}
      onCreated={(record) => created(screen.id, record)}
      onCancel={back}
    />}
    {shown.kind === "error" && <div className="view-problem" role="alert">
      <span>{shown.message || t`The collection could not answer.`}</span>
      {shown.link && <button type="button" className="mdbase-button is-primary" onClick={() => host.openLink(shown.link!)}>
        <span className="mdbase-button-label">{t({ message: "Approve again", context: "Opens the approval page for a collection whose access lapsed" })}</span>
      </button>}
    </div>}
    {shown.kind === "unsupported" && <p className="view-empty">{t`There is nothing here to show.`}</p>}
  </div>;
}

function ViewHeader({ host, connectionId, recordPath, display, onBack }: {
  readonly host: Host;
  readonly connectionId: string;
  /** The record shown, which the Editor opens to; otherwise it opens the collection. */
  readonly recordPath: string | undefined;
  readonly display: Display;
  readonly onBack: (() => void) | undefined;
}): JSX.Element {
  const activity = useMdbaseMarkActivity();
  // The name and the Editor link are niceties: without them the header shows the mark alone.
  const name = useCollection(host, connectionId)?.name;
  const editor = useEditorLink(host, connectionId);
  return <header className="view-head">
    {onBack && <button type="button" className="mdbase-button is-tertiary view-back" onClick={onBack}>
      <span className="mdbase-button-label">{t({ message: "Back", context: "Returns from a record to the query results" })}</span>
    </button>}
    <span className="view-brand">
      <MdbaseMark className="view-mark" motion={activity.busy ?? undefined} signal={activity.signal} progress={activity.progress} />
      <span>{name || "mdbase"}</span>
    </span>
    <span className="view-head-actions">
      {editor && <button type="button" className="mdbase-button is-tertiary" onClick={() => host.openLink(recordPath ? editorRecordLink(editor, recordPath) : editor)}>
        <span className="mdbase-button-label">{t({ message: "Open in Editor", context: "Opens the record or collection in the mdbase Editor" })}</span>
      </button>}
      {display.canFill && <button type="button" className="mdbase-button is-tertiary" onClick={() => host.display(display.full ? "inline" : "fullscreen")}>
        <span className="mdbase-button-label">{display.full
          ? t({ message: "Exit full screen", context: "Returns the view to its place in the conversation" })
          : t({ message: "Full screen", context: "Shows the view over the whole conversation" })}</span>
      </button>}
    </span>
  </header>;
}
