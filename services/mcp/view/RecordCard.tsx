import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { isEmptyValue, linkToPath, mergeTypeSchemas, PropertyList, propertiesFromSchema, type PropertyRecords } from "@mdbase-dev/ui/properties";
import { SaveNotice, type SaveTone } from "@mdbase-dev/ui/save-notice";
import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { schemasOf, useCollection } from "./collection";
import type { Host } from "./host";
import { MarkdownBody, type TaskChange } from "./MarkdownBody";
import { recordTitle, type Changes, type Json, type RecordDocument, type Shown } from "./model";

/** The most properties a folded card shows. */
const SUMMARY = 4;

/**
 * One record: its title, types and a few properties, unfolded on request to all its properties
 * and its body as the Editor renders it. Where the connection may update records, properties are
 * edited in place, task boxes ticked and the body edited; each change is one update_record call
 * against the revision the card last saw, so an edit made elsewhere in the meantime is refused
 * rather than overwritten. What the model's own update changed is pointed out until the next save.
 */
export function RecordCard({ host, connectionId, record: shown, renamedFrom, changes: madeByModel, open: openAtFirst, full, onOpen, onSaved }: {
  readonly host: Host;
  readonly connectionId: string;
  readonly record: RecordDocument;
  readonly renamedFrom: string | undefined;
  /** What the update that returned this record changed. */
  readonly changes?: Changes | undefined;
  /** Whether the card starts unfolded. */
  readonly open: boolean;
  /** Whether the view fills the screen, where the card is always unfolded. */
  readonly full: boolean;
  /** Opens another record by its path, for a property that links to it. */
  readonly onOpen: (path: string) => void;
  /** A change made here was saved. */
  readonly onSaved?: ((record: RecordDocument) => void) | undefined;
}): JSX.Element {
  useLingui();
  const [record, setRecord] = useState(shown);
  const [draft, setDraft] = useState<Json>(shown.frontmatter);
  const collection = useCollection(host, connectionId);
  const [tone, setTone] = useState<SaveTone | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [changes, setChanges] = useState(madeByModel);
  const [unfolded, setUnfolded] = useState(openAtFirst);
  const [editing, setEditing] = useState(false);
  /** Bumped to show the body as saved again after a refused tick. */
  const [bodyShown, setBodyShown] = useState(0);
  const bodyDraft = useRef(shown.body);
  const latest = useRef(shown);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const card = useRef<HTMLElement>(null);

  const declared = useMemo(() => {
    if (!collection) return [];
    const { properties, required } = mergeTypeSchemas(schemasOf(collection, record.types));
    return propertiesFromSchema(properties, required, undefined, draft);
  }, [collection, record.types, draft]);

  // Folded, the card shows what the model just changed, then what the type requires, then the rest in the type's order.
  const summary = useMemo(() => new Set([...new Set([
    ...(changes?.set ?? []),
    ...declared.filter((field) => field.required).map((field) => field.name),
    ...declared.map((field) => field.name),
    ...Object.keys(draft),
  ])].filter((name) => name !== "title" && !isEmptyValue(draft[name])).slice(0, SUMMARY)), [changes, declared, draft]);
  const editable = collection?.editable === true;
  const folded = !(unfolded || full);
  // Unfolding shows more of the record, or room to write its body.
  const more = editable || record.body.trim() !== "" || Object.keys(draft).some((name) => name !== "title" && !summary.has(name) && !isEmptyValue(draft[name]));

  useLayoutEffect(() => {
    for (const row of card.current?.querySelectorAll<HTMLElement>(".mdbase-property[data-field]") ?? []) {
      row.toggleAttribute("data-changed", changes?.set.includes(row.dataset.field!) ?? false);
    }
  });

  const records = useMemo<PropertyRecords>(() => ({
    describe: () => undefined,
    search: () => [],
    open: (link) => {
      const path = linkToPath(link);
      if (path) onOpen(path);
    },
  }), [onOpen]);

  /**
   * One update_record after the ones before it, against the revision the last returned. Resolves
   * whether it was saved; a refusal is said in the card and `refused` puts back what it showed.
   */
  function write(change: Json, told: (saved: RecordDocument) => string, refused: (before: RecordDocument) => void): Promise<boolean> {
    setTone("saving");
    setProblem(null);
    const done = saving.current.then(async () => {
      const before = latest.current;
      const result: Shown = await host.show("update_record", { connection_id: connectionId, path: before.path, if_revision: before.revision, ...change });
      if (result.kind === "record") {
        latest.current = result.record;
        setRecord(result.record);
        setDraft(result.record.frontmatter);
        setChanges(undefined);
        setTone("saved");
        onSaved?.(result.record);
        host.tell(told(result.record));
        return true;
      }
      refused(before);
      setTone("attention");
      setProblem(result.kind === "error" && result.message ? result.message : t`The change could not be saved.`);
      return false;
    });
    saving.current = done;
    return done;
  }

  function saveProperty(name: string, value: unknown): void {
    setDraft((current) => {
      const next = { ...current };
      if (value === null) delete next[name];
      else next[name] = value;
      return next;
    });
    void write(value === null ? { unset: [name] } : { patch: { [name]: value } }, (saved) => value === null
      ? `In the mdbase view the user removed "${name}" from ${saved.path}; its revision is now ${saved.revision}.`
      : `In the mdbase view the user set "${name}" on ${saved.path} to ${JSON.stringify(value)}; its revision is now ${saved.revision}.`,
    (before) => setDraft(before.frontmatter));
  }

  function tick({ body, task, done }: TaskChange): void {
    void write({ body }, (saved) => `In the mdbase view the user ${done ? "ticked" : "cleared"} the task "${task}" in ${saved.path}; its revision is now ${saved.revision}.`,
      () => setBodyShown((count) => count + 1));
  }

  async function saveBody(): Promise<void> {
    if (bodyDraft.current === latest.current.body) return setEditing(false);
    // A refused edit stays open, so that nothing typed is lost.
    if (await write({ body: bodyDraft.current }, (saved) => `In the mdbase view the user edited the body of ${saved.path}; its revision is now ${saved.revision}.`, () => undefined)) setEditing(false);
  }

  async function reload(): Promise<void> {
    const result = await host.show("read_record", { connection_id: connectionId, path: latest.current.path });
    if (result.kind !== "record") return setProblem(result.kind === "error" && result.message ? result.message : t`The record could not be read again.`);
    latest.current = result.record;
    setRecord(result.record);
    setDraft(result.record.frontmatter);
    setEditing(false);
    setBodyShown((count) => count + 1);
    setTone(null);
    setProblem(null);
  }

  const title = recordTitle(record);
  return <article className={folded ? "view-record is-folded mdbase-settle-host" : "view-record mdbase-settle-host"} aria-label={title} ref={card}>
    <header className="view-record-head">
      <div className="view-record-title">
        <h1>{title}</h1>
        {tone && <SaveNotice tone={tone} />}
      </div>
      <p className="view-record-path">
        <span>{record.path}</span>
        {renamedFrom && <span className="view-muted">{t`Moved from ${renamedFrom}`}</span>}
      </p>
      {record.types.length > 0 && <ul className="view-types" aria-label={t({ message: "Types", context: "List of the mdbase types a record has" })}>
        {record.types.map((type) => <li key={type}>{type}</li>)}
      </ul>}
      {changes && <ChangeNote changes={changes} />}
    </header>
    {problem && <div className="view-problem" role="alert">
      <span>{problem}</span>
      <button type="button" className="mdbase-button" onClick={() => void reload()}>{t({ message: "Reload", context: "Reads the record again after a save failed" })}</button>
    </div>}
    <PropertyList
      values={draft}
      declared={declared}
      hidden={(name) => name === "title" || (folded && !summary.has(name))}
      records={records}
      onChange={editable ? saveProperty : undefined}
    />
    {!folded && <section className="view-body-section" aria-label={t`Body`}>
      {(record.body.trim() || editing) && <MarkdownBody
        key={bodyShown}
        text={record.body}
        label={t`Body of ${title}`}
        editing={editing}
        onTask={editable ? tick : undefined}
        onDraft={(text) => { bodyDraft.current = text; }}
      />}
      {editable && <div className="view-body-actions">
        {editing
          ? <>
            <button type="button" className="mdbase-button is-primary" onClick={() => void saveBody()}><span className="mdbase-button-label">{t({ message: "Save", context: "Saves the edited body of a record" })}</span></button>
            <button type="button" className="mdbase-button is-tertiary" onClick={() => setEditing(false)}><span className="mdbase-button-label">{t({ message: "Cancel", context: "Stops editing a record's body without saving" })}</span></button>
          </>
          : <button type="button" className="mdbase-button is-tertiary" onClick={() => { bodyDraft.current = latest.current.body; setEditing(true); }}>
            <span className="mdbase-button-label">{record.body.trim() ? t({ message: "Edit text", context: "Edits a record's body" }) : t({ message: "Add text", context: "Starts writing the body of a record that has none" })}</span>
          </button>}
      </div>}
    </section>}
    {!full && (more || !folded) && <button type="button" className="mdbase-button is-tertiary view-fold" aria-expanded={!folded} onClick={() => setUnfolded(folded)}>
      <span className="mdbase-button-label">{folded ? t({ message: "Show more", context: "Unfolds a record card to all its properties and its body" }) : t({ message: "Show less", context: "Folds a record card back to its summary" })}</span>
    </button>}
  </article>;
}

/** What the model's update changed: the fields it set are marked in the list, the rest said here. */
function ChangeNote({ changes }: { readonly changes: Changes }): JSX.Element {
  const { i18n } = useLingui();
  const list = new Intl.ListFormat(i18n.locale, { type: "conjunction" });
  const changed = list.format(changes.set);
  const removed = list.format(changes.removed);
  return <p className="view-changes">
    {changes.set.length > 0 && <span>{t({ message: `Changed ${changed}`, context: "Names the properties the last update changed" })}</span>}
    {changes.removed.length > 0 && <span>{t({ message: `Removed ${removed}`, context: "Names the properties the last update removed" })}</span>}
    {changes.body && <span>{t`Changed the text`}</span>}
  </p>;
}
