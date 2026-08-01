import {
  BracketsCurlyIcon as Braces,
  FileCodeIcon as FileCode2,
  XIcon as X
} from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import { CodeEditor } from "./CodeEditor";
import type { NoteDocument } from "./model";
import { composeRecordSource } from "./record-source";
import { propertyValidationErrors, StructuredPropertiesEditor } from "./StructuredPropertiesEditor";

interface PropertiesPanelProps {
  note: NoteDocument;
  types: CollectionTypeDescriptor[];
  recordPaths?: string[];
  error?: string;
  onClose: () => void;
  onSave: (path: string, value: JsonObject) => Promise<void>;
  onSaveDocument?: (document: string, previousDocument: string) => Promise<boolean> | boolean | void;
}

export function PropertiesPanel({
  note,
  types,
  recordPaths = [],
  error,
  onClose,
  onSave,
  onSaveDocument
}: PropertiesPanelProps) {
  const initial = useMemo(() => structuredClone(note.frontmatter), [note]);
  const initialDocument = note.document ?? composeRecordSource(note.frontmatter, note.body ?? "");
  const contract = useMemo(() => mergedSchema(note.types, types), [note.types, types]);
  const [draft, setDraft] = useState<JsonObject>(initial);
  const [mode, setMode] = useState<"fields" | "json" | "source">("fields");
  const [raw, setRaw] = useState(() => JSON.stringify(initial, null, 2));
  const [source, setSource] = useState(initialDocument);
  const sourceBaseline = useRef(initialDocument);
  const latestSource = useRef(source);
  const sourceSaveCallback = useRef(onSaveDocument);
  const sourceSavePromise = useRef<Promise<boolean> | undefined>(undefined);
  const lastSourceSubmitted = useRef(initialDocument);
  const [rawError, setRawError] = useState<string>();
  const [structuredFieldsValid, setStructuredFieldsValid] = useState(true);
  const [autoSaveState, setAutoSaveState] = useState<"saved" | "waiting" | "saving">("saved");
  const [saving, setSaving] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const sourceChanged = source !== initialDocument;
  const initialFingerprint = JSON.stringify(initial);
  const draftFingerprint = JSON.stringify(draft);
  const validationFingerprint = JSON.stringify(propertyValidationErrors(draft, contract));
  const fieldsInvalid = Boolean(rawError) || !structuredFieldsValid || validationFingerprint !== "{}";
  const latestDraft = useRef(draft);
  const latestFieldsInvalid = useRef(fieldsInvalid);
  const saveCallback = useRef(onSave);
  const lastSubmitted = useRef(initialFingerprint);
  const saveGeneration = useRef(0);

  useEffect(() => { latestDraft.current = draft; }, [draft]);
  useEffect(() => { latestFieldsInvalid.current = fieldsInvalid; }, [fieldsInvalid]);
  useEffect(() => { saveCallback.current = onSave; }, [onSave]);
  latestSource.current = source;
  sourceSaveCallback.current = onSaveDocument;
  useEffect(() => {
    const previous = sourceBaseline.current;
    sourceBaseline.current = initialDocument;
    setSource((current) => {
      if (current !== previous) return current;
      latestSource.current = initialDocument;
      lastSourceSubmitted.current = initialDocument;
      return initialDocument;
    });
  }, [initialDocument]);
  useEffect(() => {
    if (!changed || fieldsInvalid) {
      if (!changed) {
        lastSubmitted.current = draftFingerprint;
        setAutoSaveState("saved");
      }
      return;
    }
    setAutoSaveState("waiting");
    const generation = ++saveGeneration.current;
    const timer = window.setTimeout(() => {
      lastSubmitted.current = draftFingerprint;
      setAutoSaveState("saving");
      void Promise.resolve(saveCallback.current(note.path, draft)).then(() => {
        if (generation === saveGeneration.current) setAutoSaveState("saved");
      }).catch(() => {
        if (generation === saveGeneration.current) setAutoSaveState("waiting");
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [changed, draft, draftFingerprint, fieldsInvalid, note.path, validationFingerprint]);
  useEffect(() => () => {
    const latest = latestDraft.current;
    const fingerprint = JSON.stringify(latest);
    if (!latestFieldsInvalid.current && fingerprint !== lastSubmitted.current) {
      void Promise.resolve(saveCallback.current(note.path, latest)).catch(() => undefined);
    }
  }, [note.path]);
  useEffect(() => () => {
    const latest = latestSource.current;
    const baseline = sourceBaseline.current;
    if (latest === baseline || latest === lastSourceSubmitted.current || sourceSavePromise.current) return;
    lastSourceSubmitted.current = latest;
    void Promise.resolve(sourceSaveCallback.current?.(latest, baseline)).catch(() => undefined);
  }, [note.path]);

  function change(next: JsonObject) {
    setDraft(next);
    setRaw(JSON.stringify(next, null, 2));
    setRawError(undefined);
  }

  function updateRaw(value: string) {
    setRaw(value);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Frontmatter must be a JSON object.");
      }
      setDraft(parsed as JsonObject);
      setRawError(undefined);
    } catch (parseError) {
      setRawError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
    }
  }

  async function saveSource(closeAfterSave = false) {
    if (!sourceChanged) {
      if (closeAfterSave) onClose();
      return;
    }
    if (sourceSavePromise.current) {
      const succeeded = await sourceSavePromise.current;
      if (succeeded && closeAfterSave) onClose();
      return;
    }
    const next = source;
    const baseline = sourceBaseline.current;
    lastSourceSubmitted.current = next;
    setSaving(true);
    const pending = Promise.resolve(onSaveDocument?.(next, baseline))
      .then((result) => result !== false)
      .catch(() => false);
    sourceSavePromise.current = pending;
    const succeeded = await pending;
    sourceSavePromise.current = undefined;
    setSaving(false);
    if (!succeeded) lastSourceSubmitted.current = baseline;
    if (succeeded && closeAfterSave) onClose();
  }

  function closePanel() {
    if (mode === "source" && sourceChanged) {
      void saveSource(true);
      return;
    }
    onClose();
  }

  return <aside className="properties-panel" aria-label="Note properties">
    <header className="panel-header">
      <div><h2>Properties</h2><p>{note.types.length ? note.types.join(", ") : "Untyped record"}</p></div>
      <button className="icon-button" aria-label="Close properties" onClick={closePanel}><X aria-hidden="true" /></button>
    </header>

    <dl className="file-facts">
      <div><dt>Path</dt><dd>{note.path}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(note.file?.size)}</dd></div>
      <div><dt>Modified</dt><dd>{formatDate(note.file?.mtime)}</dd></div>
    </dl>

    <div className="panel-tabs" role="tablist" aria-label="Record view" onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const modes = ["fields", "json", "source"] as const;
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = modes[(modes.indexOf(mode) + offset + modes.length) % modes.length];
      setMode(next);
      document.getElementById(`properties-${next}-tab`)?.focus();
    }}>
      <button id="properties-fields-tab" role="tab" aria-controls="properties-fields-panel" aria-selected={mode === "fields"} tabIndex={mode === "fields" ? 0 : -1} onClick={() => setMode("fields")}>Fields</button>
      <button id="properties-json-tab" role="tab" aria-controls="properties-json-panel" aria-selected={mode === "json"} tabIndex={mode === "json" ? 0 : -1} onClick={() => setMode("json")}><Braces aria-hidden="true" /> JSON</button>
      <button id="properties-source-tab" role="tab" aria-controls="properties-source-panel" aria-selected={mode === "source"} tabIndex={mode === "source" ? 0 : -1} onClick={() => setMode("source")}><FileCode2 aria-hidden="true" /> Source</button>
    </div>

    {mode === "fields" ? <div id="properties-fields-panel" className="property-fields" role="tabpanel" aria-labelledby="properties-fields-tab">
      <StructuredPropertiesEditor
        value={draft}
        contract={contract}
        effectiveValues={note.effective_frontmatter}
        recordPaths={recordPaths}
        onChange={change}
        onValidityChange={setStructuredFieldsValid}
      />
    </div> : mode === "json" ? <div id="properties-json-panel" className="raw-properties" role="tabpanel" aria-labelledby="properties-json-tab">
      <p className="raw-properties-note">Persisted frontmatter only. For the complete Markdown record, use Source.</p>
      <CodeEditor value={raw} onChange={updateRaw} label="Raw frontmatter JSON" language="json" lineWrapping={false} />
      {rawError && <p className="property-error" role="alert">{rawError}</p>}
    </div> : <div id="properties-source-panel" className="record-source" role="tabpanel" aria-labelledby="properties-source-tab">
      <p>Exact Markdown source, including YAML frontmatter and body.</p>
      <CodeEditor value={source} onChange={setSource} onBlur={() => void saveSource()} label="Complete record source" language="markdown" lineWrapping={false} />
    </div>}

    <div className="property-footer">
      {error && <p className="property-error" role="alert">{error}</p>}
      {mode === "source"
        ? <div className="source-save-actions">
          <p className="property-save-state" aria-live="polite">{saving
            ? "Saving source…"
            : sourceChanged
              ? "Source saves when focus leaves the editor"
              : "Source saved"}</p>
          <button className="property-save" disabled={!sourceChanged || saving} onClick={() => void saveSource(true)}>{saving ? "Saving…" : "Save source"}</button>
        </div>
        : <p className="property-save-state" aria-live="polite">{rawError
          ? "Fix the JSON to continue saving"
          : fieldsInvalid
            ? "Fix invalid fields to continue saving"
            : autoSaveState === "saving"
              ? "Saving changes…"
              : autoSaveState === "waiting"
                ? "Changes save automatically"
                : "All changes saved"}</p>}
    </div>
  </aside>;
}

function mergedSchema(typeNames: string[], types: CollectionTypeDescriptor[]): { properties: Record<string, JsonObject>; required: string[] } {
  const properties: Record<string, JsonObject> = {};
  const required = new Set<string>();
  for (const typeName of typeNames) {
    const descriptor = types.find((type) => type.name.toLocaleLowerCase() === typeName.toLocaleLowerCase());
    const declared = descriptor?.schema.properties;
    if (declared && !Array.isArray(declared) && typeof declared === "object") {
      for (const [name, schema] of Object.entries(declared)) {
        if (schema && !Array.isArray(schema) && typeof schema === "object") properties[name] = schema as JsonObject;
      }
    }
    if (Array.isArray(descriptor?.schema.required)) {
      for (const name of descriptor.schema.required) if (typeof name === "string") required.add(name);
    }
  }
  return { properties, required: [...required] };
}

function formatBytes(value?: number): string {
  if (value === undefined) return "Unknown";
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
