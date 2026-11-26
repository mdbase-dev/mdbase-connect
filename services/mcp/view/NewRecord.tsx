import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { mergeTypeSchemas, PropertyList, propertiesFromSchema } from "@mdbase-dev/ui/properties";
import { useMemo, useState, type JSX } from "react";
import { schemasOf, useCollection } from "./collection";
import type { Host } from "./host";
import type { Json, RecordDocument } from "./model";

/**
 * A new record of one type: a title and the properties the type declares, the required ones in
 * view. One create_record makes it; the collection chooses its path and checks it against the type.
 * It is not a form: hosts frame the view without letting forms submit, so Create is a plain button.
 */
export function NewRecord({ host, connectionId, type, onCreated, onCancel }: {
  readonly host: Host;
  readonly connectionId: string;
  readonly type: string;
  readonly onCreated: (record: RecordDocument) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  useLingui();
  const collection = useCollection(host, connectionId);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState<Json>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const declared = useMemo(() => {
    if (!collection) return [];
    const { properties, required } = mergeTypeSchemas(schemasOf(collection, [type]));
    return propertiesFromSchema(properties, required, undefined, draft);
  }, [collection, type, draft]);

  async function create(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const frontmatter = title.trim() ? { ...draft, title: title.trim() } : draft;
    const result = await host.show("create_record", { connection_id: connectionId, type, frontmatter });
    setBusy(false);
    if (result.kind !== "record") return setProblem(result.kind === "error" && result.message ? result.message : t`The record could not be made.`);
    host.tell(`In the mdbase view the user created ${result.record.path}, a ${type}; its revision is ${result.record.revision}.`);
    onCreated(result.record);
  }

  return <section className="view-new" aria-label={t({ message: `New ${type}`, context: "Heading of the form that makes a record of a type" })}>
    <h1>{t({ message: `New ${type}`, context: "Heading of the form that makes a record of a type" })}</h1>
    <label className="view-new-title">
      <span>{t({ message: "Title", context: "Field for a new record's title" })}</span>
      <input
        className="mdbase-field"
        value={title}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void create(); }}
      />
    </label>
    <PropertyList
      values={draft}
      declared={declared}
      hidden={(name) => name === "title"}
      onChange={(name, value) => setDraft((current) => {
        const next = { ...current };
        if (value === null) delete next[name];
        else next[name] = value;
        return next;
      })}
    />
    {problem && <div className="view-problem" role="alert"><span>{problem}</span></div>}
    <div className="view-new-actions">
      <button type="button" className="mdbase-button is-primary" disabled={busy} aria-busy={busy} onClick={() => void create()}>
        <span className="mdbase-button-label">{t({ message: "Create", context: "Makes the new record" })}</span>
      </button>
      <button type="button" className="mdbase-button is-tertiary" onClick={onCancel}>
        <span className="mdbase-button-label">{t({ message: "Cancel", context: "Leaves the new record form without making it" })}</span>
      </button>
    </div>
  </section>;
}
