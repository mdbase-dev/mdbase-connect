import { ArrowLeft, FileCode2, PanelLeft, Search, X } from "lucide-react";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase/connect";
import { useMemo, useState, type ReactNode } from "react";
import { stringify } from "yaml";
import { CodeEditor } from "./CodeEditor";

export function TypeList({ types, selectedName, leadingActions, trailingActions, onSelect, onCollections }: {
  types: CollectionTypeDescriptor[];
  selectedName?: string;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onSelect: (name: string) => void;
  onCollections: () => void;
}) {
  const [search, setSearch] = useState("");
  const visible = types.filter((type) => `${type.name} ${type.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="type-list-pane" aria-label="Types">
    <header className="list-header">
      <button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button>
      {leadingActions}
      <div><h1>Types</h1><p>{types.length} {types.length === 1 ? "definition" : "definitions"}</p></div>
      {trailingActions}
    </header>
    <label className="search-field">
      <Search aria-hidden="true" /><span className="sr-only">Search types</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search types" />
      {search && <button aria-label="Clear type search" onClick={() => setSearch("")}><X aria-hidden="true" /></button>}
    </label>
    <div className="type-list" role="listbox" aria-label="Collection types">
      {visible.map((type) => <button key={type.name} role="option" aria-selected={selectedName === type.name} className={`type-row${selectedName === type.name ? " selected" : ""}`} onClick={() => onSelect(type.name)}>
        <FileCode2 aria-hidden="true" /><span><strong>{type.name}</strong><small>{type.description || `${propertyCount(type)} schema properties`}</small></span>
      </button>)}
      {!visible.length && <p className="quiet-empty">{types.length ? "No types found." : "This collection has no type definitions."}</p>}
    </div>
  </section>;
}

export function TypeInspector({ type, leadingActions, onBack }: { type?: CollectionTypeDescriptor; leadingActions?: ReactNode; onBack: () => void }) {
  const source = useMemo(() => type ? stringify(typeDefinition(type), { lineWidth: 0 }) : "", [type]);
  if (!type) return <main className="type-inspector empty-type">{leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}<p>Select a type definition to inspect it.</p></main>;
  return <main className="type-inspector" aria-label={`${type.name} type definition`}>
    <header className="type-inspector-bar">
      <button className="mobile-back icon-button" aria-label="Back to types" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <span>{type.path ?? `_types/${type.name}.md`}</span>
      <small>Inspecting</small>
    </header>
    <section className="type-heading">
      <p className="eyebrow">Type definition</p>
      <h1>{type.name}</h1>
      {type.description && <p>{type.description}</p>}
      <dl>
        <div><dt>Version</dt><dd>{type.version ?? "Unversioned"}</dd></div>
        <div><dt>Properties</dt><dd>{propertyCount(type)}</dd></div>
        <div><dt>Extensions</dt><dd>{Object.keys(type.extensions).length}</dd></div>
      </dl>
    </section>
    <section className="type-source">
      <div><h2>Definition</h2><p>Resolved collection metadata remains visible alongside the source declaration.</p></div>
      <CodeEditor value={source} label={`${type.name} type YAML`} language="yaml" readOnly lineWrapping={false} />
    </section>
  </main>;
}

function typeDefinition(type: CollectionTypeDescriptor): JsonObject {
  if (type.definition) return type.definition;
  return clean({
    kind: "mdbase.type",
    name: type.name,
    version: type.version,
    description: type.description,
    schema: { dialect: "json-schema-2020-12", value: type.schema },
    collection: type.collection,
    lifecycle: type.lifecycle,
    ...type.extensions
  });
}

function clean(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function propertyCount(type: CollectionTypeDescriptor): number {
  const properties = type.schema.properties;
  return properties && !Array.isArray(properties) && typeof properties === "object" ? Object.keys(properties).length : 0;
}
