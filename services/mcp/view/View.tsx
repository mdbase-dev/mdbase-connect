import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { useMdbaseMarkActivity } from "@mdbase-dev/ui/mark-activity";
import { OpeningScreen } from "@mdbase-dev/ui/screens";
import { useCallback, useEffect, useState, type JSX } from "react";
import { collection } from "./collection";
import type { Host } from "./host";
import { appendPage, type Json, type Shown } from "./model";
import { RecordCard } from "./RecordCard";
import { GroupsTable, RecordsTable } from "./RecordsTable";

/** What one screen of the view shows, and the call that produced it. */
export interface Screen {
  readonly connectionId: string;
  readonly args: Json;
  readonly shown: Shown | { readonly kind: "loading"; readonly title: string };
}

/**
 * The view a tool call opens: query results or a record. Opening a record from the results
 * shows it in place, with a way back to the results.
 */
export function View({ host, first }: { readonly host: Host; readonly first: Screen }): JSX.Element {
  useLingui();
  const [stack, setStack] = useState<readonly Screen[]>([first]);
  const screen = stack[stack.length - 1]!;

  const open = useCallback((path: string, title: string) => {
    const connectionId = screen.connectionId;
    const args = { connection_id: connectionId, path };
    setStack((current) => [...current, { connectionId, args, shown: { kind: "loading", title } }]);
    void host.show("read_record", args).then((shown) => setStack((current) => {
      const top = current[current.length - 1];
      // Back was pressed while it loaded.
      return top?.args === args ? [...current.slice(0, -1), { ...top, shown }] : current;
    }));
  }, [host, screen.connectionId]);

  async function more(): Promise<void> {
    const from = screen;
    if (from.shown.kind !== "records" || !from.shown.cursor) return;
    const page = await host.show("query_records", { ...from.args, cursor: from.shown.cursor });
    const shown = appendPage(from.shown, page) ?? page;
    // A record opened while the page loaded stays on top; the page goes to the results it extends.
    setStack((current) => current.map((item) => item === from ? { ...from, shown } : item));
  }

  const shown = screen.shown;
  return <div className="view">
    <ViewHeader host={host} connectionId={screen.connectionId} onBack={stack.length > 1 ? () => setStack((current) => current.slice(0, -1)) : undefined} />
    {shown.kind === "loading" && <OpeningScreen app={{ name: "mdbase" }} layout="panel" title={t`Opening ${shown.title}`} />}
    {shown.kind === "records" && <RecordsTable shown={shown} onOpen={(row) => open(row.path, row.name)} onMore={more} />}
    {shown.kind === "groups" && <GroupsTable shown={shown} />}
    {shown.kind === "record" && <RecordCard
      key={shown.record.path}
      host={host}
      connectionId={screen.connectionId}
      record={shown.record}
      renamedFrom={shown.renamedFrom}
      onOpen={(path) => open(path, path)}
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

function ViewHeader({ host, connectionId, onBack }: { readonly host: Host; readonly connectionId: string; readonly onBack: (() => void) | undefined }): JSX.Element {
  const activity = useMdbaseMarkActivity();
  const [name, setName] = useState("");
  useEffect(() => {
    let current = true;
    // The name is a nicety: without it the header shows the mark alone.
    collection(host, connectionId).then((found) => { if (current) setName(found.name); }, () => undefined);
    return () => { current = false; };
  }, [host, connectionId]);
  return <header className="view-head">
    {onBack && <button type="button" className="mdbase-button is-tertiary view-back" onClick={onBack}>
      <span className="mdbase-button-label">{t({ message: "Back", context: "Returns from a record to the query results" })}</span>
    </button>}
    <span className="view-brand">
      <MdbaseMark className="view-mark" motion={activity.busy ?? undefined} signal={activity.signal} progress={activity.progress} />
      <span>{name || "mdbase"}</span>
    </span>
  </header>;
}
