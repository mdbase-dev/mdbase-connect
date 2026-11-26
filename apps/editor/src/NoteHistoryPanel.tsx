import { Trans } from "@lingui/react/macro";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { isMdbaseError } from "@mdbase-dev/sdk";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";
import { compareLines } from "@mdbase-dev/ui/text-diff";
import { useEffect, useMemo, useRef, useState } from "react";
import { gatewayError } from "./gateway";
import { ArrowLeftIcon as ArrowLeft, XIcon as X } from "./icons";
import type { CollectionGateway, NoteHistory, NoteHistoryReader, NoteVersion } from "./model";
import { dateLabel, dayLabel, historyTimeline, timeLabel, versionAuthor, versionChange, type HistoryRow } from "./note-history";

type Problem =
  /** The collection's replica serves no history (hosted, local-only, or older). */
  | { kind: "unsupported" }
  /** The editor's access to this collection doesn't include history. */
  | { kind: "access" }
  | { kind: "error"; message: string };

function problemOf(error: unknown): Problem {
  if (isMdbaseError(error, "upgrade_required") && error.reason === "history_unsupported") return { kind: "unsupported" };
  if (isMdbaseError(error, "forbidden")) return { kind: "access" };
  return { kind: "error", message: gatewayError(error) };
}

interface Timeline {
  versions: NoteVersion[];
  from: number;
  fromTime?: number;
  next?: number;
}

function merge(current: Timeline | undefined, page: NoteHistory): Timeline {
  return { versions: [...(current?.versions ?? []), ...page.versions], from: page.from, fromTime: page.fromTime, next: page.next };
}

/**
 * The open note's saved versions, newest first, in the inspector: grouped by
 * day, one author's run of saves as one row. A version opens as a read-only
 * diff against the note as saved now, and can be restored over it.
 */
export function NoteHistoryPanel({ history, gateway, path, title, current, onRestore, onAuthorize, onClose }: {
  history: NoteHistoryReader;
  /** Only to tell the signed-in account's versions apart. */
  gateway: Pick<CollectionGateway, "peopleDirectory">;
  path: string;
  title: string;
  /** The note's saved text now: what a version is compared with. */
  current: string;
  /** Write a version's text back through the note's save queue. Absent when
   * the note can't be edited. Resolves false when the save didn't happen. */
  onRestore?: (document: string) => Promise<boolean>;
  /** Ask for access again, when the grant lacks history. */
  onAuthorize: () => void;
  onClose: () => void;
}) {
  useLingui();
  const [timeline, setTimeline] = useState<Timeline>();
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<Problem>();
  const [me, setMe] = useState<string>();
  const [selected, setSelected] = useState<HistoryRow>();
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef<AbortController>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setLoading(true);
    setProblem(undefined);
    history.list(path, { signal: controller.signal }).then(
      (page) => { if (!controller.signal.aborted) { setTimeline(merge(undefined, page)); setLoading(false); } },
      (error: unknown) => { if (!controller.signal.aborted) { setProblem(problemOf(error)); setLoading(false); } }
    );
    return () => controller.abort();
  }, [history, path, attempt]);

  // Only to tell your own versions apart; without it, versions are told by app and device.
  useEffect(() => {
    if (!gateway.peopleDirectory) return;
    const controller = new AbortController();
    gateway.peopleDirectory({ signal: controller.signal }).then(
      (directory) => { if (!controller.signal.aborted) setMe(directory.account.accountId); },
      () => undefined
    );
    return () => controller.abort();
  }, [gateway]);

  function loadOlder() {
    const before = timeline?.next;
    const controller = lifetime.current;
    if (before === undefined || !controller) return;
    setLoading(true);
    history.list(path, { before, signal: controller.signal }).then(
      (page) => { if (!controller.signal.aborted) { setTimeline((current) => merge(current, page)); setLoading(false); } },
      (error: unknown) => { if (!controller.signal.aborted) { setProblem(problemOf(error)); setLoading(false); } }
    );
  }

  const days = useMemo(() => historyTimeline(timeline?.versions ?? []), [timeline]);

  return <aside className="properties-panel history-panel" aria-label={t`Version history`}>
    <header className="panel-header">
      <div><h2><Trans>History</Trans></h2><p>{title}</p></div>
      <button className="icon-button" aria-label={t`Close history`} data-inspector-close onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="history-panel-body">
      {selected
        ? <VersionView key={selected.version.seq} history={history} path={path} row={selected} me={me} current={current}
          onRestore={onRestore && (async (document) => {
            const restored = await onRestore(document);
            if (restored) { setSelected(undefined); setTimeline(undefined); setAttempt((value) => value + 1); }
            return restored;
          })}
          onBack={() => setSelected(undefined)}
          onStale={() => { setSelected(undefined); setTimeline(undefined); setAttempt((value) => value + 1); }} />
        : <>
          {problem?.kind === "unsupported" && <div className="history-notice" role="status">
            <p><strong><Trans>History isn’t available here</Trans></strong></p>
            <p><Trans>Earlier versions of notes in this collection can’t be read here. Everything else still works.</Trans></p>
          </div>}
          {problem?.kind === "access" && <div className="history-notice" role="status">
            <p><strong><Trans>The editor can’t read history yet</Trans></strong></p>
            <p><Trans>Allow the editor to read this collection’s history to see earlier versions of your notes.</Trans></p>
            <button type="button" className="mdbase-button is-secondary" onClick={onAuthorize}><Trans>Update access</Trans></button>
          </div>}
          {problem?.kind === "error" && <div className="history-notice" role="alert">
            <p><Trans>Couldn’t load this note’s history.</Trans> {problem.message}</p>
            <button type="button" className="mdbase-button is-secondary" onClick={() => { setTimeline(undefined); setAttempt((value) => value + 1); }}><Trans>Try again</Trans></button>
          </div>}
          {days.map((day) => <section key={day.key} className="history-day" aria-labelledby={`history-day-${day.key}`}>
            <h3 id={`history-day-${day.key}`}>{dayLabel(day.key)}</h3>
            <ul>
              {day.rows.map((row) => <li key={row.version.seq}>
                <button type="button" className="history-row" onClick={() => setSelected(row)}>
                  <span className="history-row-author">{versionAuthor(row.version, me)}</span>
                  <span className="history-row-meta">{rowTime(row)}{versionChange(row.version) && <> · {versionChange(row.version)}</>}</span>
                </button>
              </li>)}
            </ul>
          </section>)}
          {loading && <p className="history-status" role="status"><Trans>Loading history…</Trans></p>}
          {!loading && !problem && timeline && <Horizon timeline={timeline} onOlder={loadOlder} />}
        </>}
    </div>
  </aside>;
}

function rowTime(row: HistoryRow): string {
  const time = timeLabel(row.version.time);
  if (row.since === undefined) return time;
  const since = timeLabel(row.since);
  return `${since === time ? time : `${since}–${time}`} · ${saveCount(row.saves)}`;
}

function saveCount(saves: number): string {
  return plural(saves, { one: "# save", other: "# saves" });
}

/** How far back the note's history goes: a way to older versions, or where they end. */
function Horizon({ timeline, onOlder }: { timeline: Timeline; onOlder: () => void }) {
  if (timeline.next !== undefined) {
    return <button type="button" className="mdbase-button is-tertiary history-older" onClick={onOlder}><Trans>Show older versions</Trans></button>;
  }
  if (timeline.versions.at(-1)?.kind === "created") return null;
  const since = timeline.fromTime === undefined ? undefined : dateLabel(timeline.fromTime);
  return <p className="history-horizon">
    {timeline.versions.length === 0 ? <Trans>No earlier versions of this note are kept.</Trans> : <Trans>Earlier versions are no longer kept.</Trans>}
    {since && <> <Trans>History goes back to {since}.</Trans></>}
  </p>;
}

type VersionText =
  | { state: "loading" }
  | { state: "ready"; document: string }
  /** `gone`: the version's text can't be read again (compacted or unreadable). */
  | { state: "error"; message: string; gone: boolean };

function VersionView({ history, path, row, me, current, onRestore, onBack, onStale }: {
  history: NoteHistoryReader;
  path: string;
  row: HistoryRow;
  me?: string;
  current: string;
  onRestore?: (document: string) => Promise<boolean>;
  onBack: () => void;
  onStale: () => void;
}) {
  useLingui();
  const { version } = row;
  const [text, setText] = useState<VersionText>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => { back.current?.focus(); }, []);
  useEffect(() => {
    if (version.kind === "deleted") return;
    const controller = new AbortController();
    setText({ state: "loading" });
    history.version(path, version.seq, { signal: controller.signal }).then(
      (document) => { if (!controller.signal.aborted) setText({ state: "ready", document }); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // The replica reopened since it listed this version: list again from the newest.
        if (isMdbaseError(error, "invalid_request") && error.reason === "history_cursor_stale") onStale();
        else setText({ state: "error", message: versionError(error), gone: isMdbaseError(error, "not_found") });
      }
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onStale is read when the read fails, not a reason to read again
  }, [history, path, version.seq, version.kind, attempt]);

  const diff = useMemo(() => text.state === "ready" && text.document !== current ? compareLines(text.document, current) : [], [text, current]);
  const when = dateLabel(version.time);

  return <div className="history-version">
    <button ref={back} type="button" className="mdbase-button is-tertiary history-back" onClick={onBack}><ArrowLeft aria-hidden="true" /><Trans>All versions</Trans></button>
    <h3>{versionAuthor(version, me)}</h3>
    <p className="history-version-meta">{when}{row.saves > 1 && <> · {saveCount(row.saves)}</>}{versionChange(version) && <> · {versionChange(version)}</>}</p>
    {version.kind === "deleted"
      ? <p className="history-status"><Trans>This version deleted the note, so it has no text.</Trans></p>
      : text.state === "loading" ? <p className="history-status" role="status"><Trans>Loading this version…</Trans></p>
      : text.state === "error" ? <div className="history-notice" role="alert">
        <p>{text.message}</p>
        {!text.gone && <button type="button" className="mdbase-button is-secondary" onClick={() => setAttempt((value) => value + 1)}><Trans>Try again</Trans></button>}
      </div>
      : text.document === current ? <p className="history-status"><Trans>This version matches the note as it is now.</Trans></p>
      : <>
        <div className="diff-legend"><span className="local"><Trans>This version</Trans></span><span className="remote"><Trans>Now</Trans></span></div>
        <div className="line-diff" role="table" aria-label={t`Differences from the note now`}>
          {diff.map((line, index) => <div className={`diff-line ${line.kind}`} role="row" key={`${line.kind}:${line.localLine ?? ""}:${line.remoteLine ?? ""}:${index}`}>
            <span className="diff-marker" aria-hidden="true">{line.kind === "local" ? "−" : line.kind === "remote" ? "+" : line.kind === "omitted" ? "···" : " "}</span>
            <span className="diff-line-number" aria-hidden="true">{line.localLine ?? line.remoteLine ?? ""}</span>
            <code role="cell">{line.kind === "local" ? <span className="sr-only">{t`Only in this version:`} </span>
              : line.kind === "remote" ? <span className="sr-only">{t`Only now:`} </span> : null}{line.text}</code>
          </div>)}
        </div>
        {onRestore && <button type="button" className="mdbase-button is-primary history-restore" onClick={() => setConfirming(true)}><Trans>Restore this version</Trans></button>}
      </>}
    {onRestore && text.state === "ready" && <ConfirmDialog open={confirming} title={t`Restore this version?`}
      consequence={t`The note’s text is replaced with this version from ${when}. The text it has now stays in history, so you can restore it later.`}
      confirmLabel={t`Restore`} pendingLabel={t`Restoring…`}
      onConfirm={async () => { await onRestore(text.document); setConfirming(false); }}
      onClose={() => setConfirming(false)} />}
  </div>;
}

function versionError(error: unknown): string {
  if (isMdbaseError(error, "not_found") && error.reason === "version_compacted") return t`This version is no longer kept.`;
  if (isMdbaseError(error, "not_found") && error.reason === "version_text_unavailable") return t`This version’s text isn’t available.`;
  return t`Couldn’t load this version. ${gatewayError(error)}`;
}
