import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { mergeTypeSchemas, PropertyList, propertiesFromSchema, linkToPath, type PropertyRecords } from "@mdbase-dev/ui/properties";
import { SaveNotice, type SaveTone } from "@mdbase-dev/ui/save-notice";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { collection as describe, schemasOf, type Collection } from "./collection";
import type { Host } from "./host";
import { MarkdownBody } from "./MarkdownBody";
import { recordTitle, type Json, type RecordDocument } from "./model";

/**
 * One record: its properties, edited in place when the connection may update records, and its
 * body as the Editor renders it. Each change is one update_record call against the revision the
 * card last saw, so an edit made elsewhere in the meantime is refused rather than overwritten.
 */
export function RecordCard({ host, connectionId, record: shown, renamedFrom, onOpen }: {
  readonly host: Host;
  readonly connectionId: string;
  readonly record: RecordDocument;
  readonly renamedFrom: string | undefined;
  /** Opens another record by its path, for a property that links to it. */
  readonly onOpen: (path: string) => void;
}): JSX.Element {
  useLingui();
  const [record, setRecord] = useState(shown);
  const [draft, setDraft] = useState<Json>(shown.frontmatter);
  const [collection, setCollection] = useState<Collection | null>(null);
  const [tone, setTone] = useState<SaveTone | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(shown);
  const saving = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let current = true;
    // Without a description the record is still shown, read-only, by what it holds.
    describe(host, connectionId).then((found) => { if (current) setCollection(found); }, () => undefined);
    return () => { current = false; };
  }, [host, connectionId]);

  const declared = useMemo(() => {
    if (!collection) return [];
    const { properties, required } = mergeTypeSchemas(schemasOf(collection, record.types));
    return propertiesFromSchema(properties, required, undefined, draft);
  }, [collection, record.types, draft]);

  const records = useMemo<PropertyRecords>(() => ({
    describe: () => undefined,
    search: () => [],
    open: (link) => {
      const path = linkToPath(link);
      if (path) onOpen(path);
    },
  }), [onOpen]);

  function save(name: string, value: unknown): void {
    setDraft((current) => {
      const next = { ...current };
      if (value === null) delete next[name];
      else next[name] = value;
      return next;
    });
    setTone("saving");
    setProblem(null);
    saving.current = saving.current.then(async () => {
      const before = latest.current;
      const shown = await host.show("update_record", {
        connection_id: connectionId,
        path: before.path,
        if_revision: before.revision,
        ...(value === null ? { unset: [name] } : { patch: { [name]: value } }),
      });
      if (shown.kind === "record") {
        latest.current = shown.record;
        setRecord(shown.record);
        setDraft(shown.record.frontmatter);
        setTone("saved");
        host.tell(value === null
          ? `In the mdbase view the user removed "${name}" from ${shown.record.path}; its revision is now ${shown.record.revision}.`
          : `In the mdbase view the user set "${name}" on ${shown.record.path} to ${JSON.stringify(value)}; its revision is now ${shown.record.revision}.`);
        return;
      }
      setDraft(before.frontmatter);
      setTone("attention");
      setProblem(shown.kind === "error" && shown.message ? shown.message : t`The change could not be saved.`);
    });
  }

  async function reload(): Promise<void> {
    const shown = await host.show("read_record", { connection_id: connectionId, path: latest.current.path });
    if (shown.kind !== "record") return setProblem(shown.kind === "error" && shown.message ? shown.message : t`The record could not be read again.`);
    latest.current = shown.record;
    setRecord(shown.record);
    setDraft(shown.record.frontmatter);
    setTone(null);
    setProblem(null);
  }

  const editable = collection?.editable === true;
  return <article className="view-record mdbase-settle-host" aria-label={recordTitle(record)}>
    <header className="view-record-head">
      <div className="view-record-title">
        <h1>{recordTitle(record)}</h1>
        {tone && <SaveNotice tone={tone} />}
      </div>
      <p className="view-record-path">
        <span>{record.path}</span>
        {renamedFrom && <span className="view-muted">{t`Moved from ${renamedFrom}`}</span>}
      </p>
      {record.types.length > 0 && <ul className="view-types" aria-label={t({ message: "Types", context: "List of the mdbase types a record has" })}>
        {record.types.map((type) => <li key={type}>{type}</li>)}
      </ul>}
    </header>
    {problem && <div className="view-problem" role="alert">
      <span>{problem}</span>
      <button type="button" className="mdbase-button" onClick={() => void reload()}>{t({ message: "Reload", context: "Reads the record again after a save failed" })}</button>
    </div>}
    <PropertyList
      values={draft}
      declared={declared}
      hidden={(name) => name === "title"}
      records={records}
      onChange={editable ? save : undefined}
    />
    {record.body.trim() && <MarkdownBody text={record.body} label={t`Body of ${recordTitle(record)}`} />}
  </article>;
}
