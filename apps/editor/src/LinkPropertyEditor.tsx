import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { LinkPicker, type LinkPickerCreate, type LinkPickerOption } from "@mdbase-dev/ui/link-picker";
import type { LinkTargets } from "./collection-links";
import { collectionDisplayField } from "./field-reference";
import { LinkIcon, PlusIcon } from "./icons";
import { ChipRemoveButton } from "./InlineRemoveButton";
import { linkMatches, type LinkSuggestion } from "./links";
import type { LinkTarget } from "./model";
import { folder, typeDisplayName, typeNameInSentence } from "./note";
import { linkValue, linkValueLabel, resolvableLinkValue, type LinkProperty } from "./record-links";
import { TypeIcon } from "./TypeIcon";

/** A record about to exist: where it will be written and what it is called. */
export interface NewLinkTarget {
  path: string;
  title: string;
}

/** The place a link is being written from, and how the link lands there. */
export interface LinkCreation {
  /** Where on screen the link is being written; nothing once that place has gone. */
  anchor: () => DOMRect | undefined;
  /** Writes the link to the new record. */
  link: (target: NewLinkTarget) => void;
  /** Hands the keyboard back when a form that took it closes. */
  restoreFocus: () => void;
}

/** Makes a record of `type` (a plain note when undefined) titled `title` and
 * links it. A record that needs only its name is linked at once, where it
 * will be written, while the collection confirms it; one that needs more is
 * linked after a short form beside `creation.anchor` is filled in. */
export type CreateLinkedRecord = (type: string | undefined, title: string, creation: LinkCreation) => void;

/** What a properties form needs to edit link properties as links. */
export interface PropertyLinks {
  /** The record's link properties, by name (`recordLinkProperties`). */
  properties: ReadonlyMap<string, LinkProperty>;
  suggestions: LinkSuggestion[];
  types: CollectionTypeDescriptor[];
  /** The collection's answers about the links written in the record. */
  targets?: LinkTargets;
  /** The record being edited: it is never offered as its own target. */
  currentPath?: string;
  recentPaths?: string[];
  onOpen?: (path: string) => void;
  onCreate?: CreateLinkedRecord;
}

/** Everything but the record's own link properties: the same for every record of a collection. */
export type RecordLinking = Omit<PropertyLinks, "properties">;

const MATCH_LIMIT = 8;
const noSubscription = () => () => {};
const noVersion = () => 0;

/** A link property's value as links: each one a chip that opens its record,
 * and a picker that finds a record of the property's type or makes one. */
export function LinkPropertyEditor({ name, link, value, links, onChange }: {
  name: string;
  link: LinkProperty;
  value: string | string[];
  links: PropertyLinks;
  onChange: (value: string | string[]) => void;
}) {
  useLingui();
  const values = useMemo(() => (Array.isArray(value) ? value : value ? [value] : []), [value]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const resolved = useResolvedLinks(links.targets, values);
  const byPath = useMemo(() => new Map(links.suggestions.map((suggestion) => [suggestion.path, suggestion])), [links.suggestions]);
  const icons = useMemo(() => new Map(links.types.map((type) => [type.name.toLocaleLowerCase(), collectionDisplayField(type, "icon")])), [links.types]);
  const iconOf = (types: readonly string[] | undefined) => types?.map((type) => icons.get(type.toLocaleLowerCase())).find(Boolean);
  const linkedPaths = new Set(resolved.flatMap((target) => target?.kind === "note" ? [target.path] : []));

  // Only records of the property's types, never the record itself or one already linked.
  // Kept by the types' names: the rule is read afresh on each render, and matching indexes this list once.
  const targetKey = link.targetTypes.map((type) => type.toLocaleLowerCase()).join("\n");
  const candidates = useMemo(() => {
    const wanted = new Set(targetKey ? targetKey.split("\n") : []);
    return links.suggestions.filter((suggestion) => suggestion.path !== links.currentPath
      && (!wanted.size || suggestion.types?.some((type) => wanted.has(type.toLocaleLowerCase()))));
  }, [targetKey, links.currentPath, links.suggestions]);
  const options: LinkPickerOption[] = linkMatches(candidates, query, undefined, MATCH_LIMIT + linkedPaths.size, { currentPath: links.currentPath, recentPaths: links.recentPaths })
    .filter(({ suggestion }) => !linkedPaths.has(suggestion.path))
    .slice(0, MATCH_LIMIT)
    .map(({ suggestion, label }) => ({
      id: suggestion.path,
      title: label,
      // One target type says nothing new on every row; the folder tells two "Ada"s apart.
      detail: link.targetTypes.length !== 1 && suggestion.types?.[0] ? typeDisplayName(suggestion.types[0]) : folder(suggestion.path),
      icon: <TypeIcon name={iconOf(suggestion.types)} fallback={<LinkIcon />} />
    }));
  const creates: LinkPickerCreate[] = !links.onCreate ? [] : link.targetTypes.length
    ? link.targetTypes.map((type) => {
      const typeLabel = typeNameInSentence(type);
      return { id: type, label: t`New ${typeLabel}` };
    })
    : [{ id: "", label: t`New note` }];

  const root = useRef<HTMLDivElement>(null);
  // A record made through a form is linked later: by then the list may hold other links.
  const latestValues = useRef(values);
  latestValues.current = values;
  // A new link replaces the control that made it: the keyboard stays with the property once it is drawn.
  const refocus = useRef(false);
  const focusProperty = () => root.current?.querySelector<HTMLElement>("input, .link-property-add, .chip-remove-button")?.focus();
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    focusProperty();
  }, [values]);

  function add(path: string, title: string) {
    const next = linkValue(path, title, link.format);
    setQuery("");
    if (link.many) onChange([...latestValues.current, next]);
    else {
      setAdding(false);
      onChange(next);
    }
  }

  function remove(index: number) {
    onChange(link.many ? values.filter((_, position) => position !== index) : "");
  }

  const picking = adding || !values.length;
  const onlyType = link.targetTypes.length === 1 ? typeNameInSentence(link.targetTypes[0]!) : undefined;
  const placeholder = links.onCreate
    ? onlyType ? t`Find or create a ${onlyType}` : t`Find or create a note`
    : onlyType ? t`Find a ${onlyType}` : t`Find a note`;
  return <div ref={root} className="link-property" role="group" aria-label={name}>
    {values.map((raw, index) => {
      const target = resolved[index];
      const suggestion = target?.kind === "note" ? byPath.get(target.path) : undefined;
      const label = suggestion?.title ?? linkValueLabel(raw);
      const unresolved = target !== undefined && target.kind !== "note" && target.kind !== "file";
      const onOpen = links.onOpen;
      return <span className={`link-chip${unresolved ? " is-unresolved" : ""}`} key={`${index}:${raw}`} title={unresolved ? t`“${raw}” does not lead to a note.` : target?.kind === "note" ? target.path : undefined}>
        {target?.kind === "note" && onOpen
          ? <button type="button" className="link-chip-target" onClick={() => onOpen(target.path)}>
            <span className="link-chip-icon" aria-hidden="true"><TypeIcon name={iconOf(suggestion?.types)} fallback={<LinkIcon />} /></span>
            <span className="link-chip-label">{label}</span>
          </button>
          : <span className="link-chip-target">
            <span className="link-chip-icon" aria-hidden="true"><LinkIcon /></span>
            <span className="link-chip-label">{label}</span>
          </span>}
        <ChipRemoveButton label={t`Remove ${label} from ${name}`} onClick={() => remove(index)} />
      </span>;
    })}
    {picking
      ? <LinkPicker
        className="link-property-picker"
        label={values.length ? t`Add a link to ${name}` : t`${name} value`}
        placeholder={placeholder}
        autoFocus={adding}
        query={query}
        onQueryChange={setQuery}
        options={options}
        creates={creates}
        createLabel={({ label }, title) => t`${label} “${title}”`}
        emptyMessage={query.trim() ? t`No matching notes.` : t`Nothing to link yet.`}
        onPick={(option) => add(option.id, option.title)}
        onCreate={(create, title) => links.onCreate?.(create.id || undefined, title, {
          anchor: () => root.current?.getBoundingClientRect(),
          link: (made) => { refocus.current = true; add(made.path, made.title); },
          restoreFocus: focusProperty
        })}
        onClose={() => { setAdding(false); setQuery(""); }}
      />
      : link.many && <button type="button" className="link-property-add" aria-label={t`Add a link to ${name}`} title={t`Add a link`} onClick={() => setAdding(true)}><PlusIcon aria-hidden="true" /></button>}
  </div>;
}

/** The collection's answer for each value, asked once per value and renewed
 * with the collection: undefined until it answers. */
function useResolvedLinks(targets: LinkTargets | undefined, values: readonly string[]): Array<LinkTarget | undefined> {
  useSyncExternalStore(targets?.subscribe ?? noSubscription, targets?.getVersion ?? noVersion);
  const raws = values.map(resolvableLinkValue);
  const asked = raws.join("\n");
  useEffect(() => {
    const wanted = asked.split("\n").filter(Boolean);
    // A failed lookup leaves the values named as written; the panel reports collection errors elsewhere.
    if (targets && wanted.length) void targets.resolveAll(wanted).catch(() => undefined);
  }, [targets, asked]);
  return raws.map((raw) => raw && targets ? targets.get(raw) : undefined);
}
