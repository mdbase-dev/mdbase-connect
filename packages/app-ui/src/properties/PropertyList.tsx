import { useMemo, useRef, useState, type JSX } from "react";

import { Combo } from "../Combo.js";
import { Glyph, type GlyphName } from "../glyphs.js";
import { useLocaleRevision } from "../i18n.js";
import { propertyLabels, type PropertyLabels } from "./labels.js";
import { blankValue, describeProperty, isEmptyValue, isGroup, isPropertyName, propertiesInUse, propertyKind, valueCount, valueLine, type PropertyInfo, type PropertyKind } from "./model.js";
import { PropertyValue, type PropertyRecords } from "./PropertyValue.js";

const kindGlyphs: Record<PropertyKind, GlyphName> = {
  choice: "choice",
  boolean: "boolean",
  date: "date",
  datetime: "date",
  number: "number",
  tags: "list",
  links: "link",
  text: "text",
  long: "text",
  group: "group",
  items: "list",
  other: "text",
};

/** The small drawing that says what kind of value a property holds, as the list's rows show it. */
export function PropertyKindIcon({ kind, size = 14 }: { readonly kind: PropertyKind; readonly size?: number | undefined }): JSX.Element {
  return <Glyph name={kindGlyphs[kind]} size={size} />;
}

export interface PropertyListProps {
  /** The record's properties, by name. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The properties the record's type declares, in its order. */
  readonly declared: readonly PropertyInfo[];
  /** Properties other records hold, with the values they hold for them: offered when adding one. */
  readonly inUse?: readonly PropertyInfo[] | undefined;
  /** Names to leave out, such as the title and the properties that are an app's machinery. */
  readonly hidden?: ((name: string) => boolean) | undefined;
  /** The other records, for properties that link to them. */
  readonly records?: PropertyRecords | undefined;
  /**
   * What is wrong with a value, by the property it belongs to. A part of a value is named through
   * its property: `progress.page`, or `steps.0.title` for the first of a list.
   */
  readonly errors?: Readonly<Record<string, string>> | undefined;
  /**
   * Absent when the record cannot be changed: its properties are then only shown. A removed
   * property is given null. A change to a part of a value gives the whole value, changed.
   */
  readonly onChange: ((name: string, value: unknown) => void) | undefined;
  /** Text to show in place of the shared catalogue's. */
  readonly labels?: Partial<PropertyLabels> | undefined;
}

const showEmptyKey = "mdbase:show-empty-properties";
/** A value with more values in it than this starts folded away. */
const openAtMost = 8;

function readShowEmpty(): boolean {
  try {
    return localStorage.getItem(showEmptyKey) === "1";
  } catch {
    return false;
  }
}

const shownAlways = (): boolean => false;
const noErrors: Readonly<Record<string, string>> = {};
const noProperties: readonly PropertyInfo[] = [];
const noValues: readonly unknown[] = [];
const noParts: Readonly<Record<string, unknown>> = {};

/** What every row of a list goes by, however deep it is. */
interface Shared {
  readonly labels: PropertyLabels;
  readonly records: PropertyRecords | undefined;
  readonly errors: Readonly<Record<string, string>>;
  /** Whether a value with parts is open, by its path. A value nobody has opened or closed is not here. */
  readonly folds: ReadonlyMap<string, boolean>;
  readonly fold: (path: string, open: boolean) => void;
}

/**
 * A record's properties, each edited in place with the control its value calls for. Properties
 * that hold nothing stay out of the way until they are asked for: one at a time through "Add
 * property", or all at once. A value with parts of its own, or a list of them, is shown part by
 * part under its property and can be folded away.
 */
export function PropertyList(props: PropertyListProps): JSX.Element {
  useLocaleRevision();
  const labels = { ...propertyLabels(), ...props.labels };
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const shared: Shared = {
    labels,
    records: props.records,
    errors: props.errors ?? noErrors,
    folds,
    fold: (path, open) => setFolds((current) => new Map(current).set(path, open)),
  };
  return (
    <div className="mdbase-properties">
      <Rows
        shared={shared}
        parent={undefined}
        values={props.values}
        declared={props.declared}
        inUse={props.inUse ?? noProperties}
        hidden={props.hidden ?? shownAlways}
        rest={undefined}
        onChange={props.onChange}
      />
    </div>
  );
}

/** The value a list's rows are the parts of: where it is in the record, and how its controls are named. */
interface Parent {
  readonly path: string;
  readonly label: string;
}

/** Named values: a record's properties at the top, a group's parts further in. */
function Rows(props: {
  readonly shared: Shared;
  readonly parent: Parent | undefined;
  readonly values: Readonly<Record<string, unknown>>;
  readonly declared: readonly PropertyInfo[];
  readonly inUse: readonly PropertyInfo[];
  readonly hidden: (name: string) => boolean;
  /** What a part nobody names holds, or false when the group may hold none. */
  readonly rest: PropertyInfo | false | undefined;
  readonly onChange: ((name: string, value: unknown) => void) | undefined;
  /** A part is being named. A value's parts are added to from its own row, which keeps this. */
  readonly adding?: boolean | undefined;
  readonly onAdding?: ((adding: boolean) => void) | undefined;
}): JSX.Element {
  const { shared, parent, values, declared, inUse, hidden, rest, onChange } = props;
  const { labels } = shared;
  const [addingHere, setAddingHere] = useState(false);
  const adding = parent ? Boolean(props.adding) : addingHere;
  const setAdding = (next: boolean): void => (parent ? props.onAdding?.(next) : setAddingHere(next));
  const [showEmpty, setShowEmpty] = useState(readShowEmpty);
  /** Properties brought into view to be filled in. */
  const [revealed, setRevealed] = useState<readonly string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  /** Properties that have held something while the record was shown: emptying one does not whisk it away. */
  const held = useRef(new Set<string>());
  const written = useRef(new Set<string>());
  // Declared properties first, in the type's order, then whatever else the record carries.
  const names = [...new Set([...declared.map((field) => field.name), ...Object.keys(values), ...revealed])].filter((name) => !hidden(name));
  for (const name of names) {
    if (!isEmptyValue(values[name])) held.current.add(name);
  }
  const must = (name: string): boolean => declared.some((field) => field.name === name && field.required);
  // A part of a value is there to be seen once the value holds it; a record's own empty properties wait to be asked for.
  const lasting = (name: string): boolean => held.current.has(name) || revealed.includes(name) || must(name) || (parent !== undefined && name in values);
  const shown = names.filter((name) => (!parent && showEmpty) || lasting(name));
  const empties = parent ? 0 : names.filter((name) => !lasting(name)).length;
  const toggleEmpty = (): void => {
    const next = !showEmpty;
    setShowEmpty(next);
    try {
      localStorage.setItem(showEmptyKey, next ? "1" : "0");
    } catch {
      // Not kept.
    }
  };
  const reveal = (name: string): void => {
    setRevealed((current) => (current.includes(name) ? current : [...current, name]));
    setFocus(name);
    setAdding(false);
  };
  const namesKey = names.join("\n");
  const shownKey = shown.join("\n");
  const candidates = useMemo(
    () => {
      const offered = new Map<string, PropertyInfo | undefined>();
      for (const name of names) {
        if (!shown.includes(name)) offered.set(name, declared.find((field) => field.name === name));
      }
      for (const field of inUse) {
        if (!names.includes(field.name) && !hidden(field.name) && field.kind !== "other") offered.set(field.name, field);
      }
      return [...offered].map(([name, info]) => ({ value: name, icon: <PropertyKindIcon kind={propertyKind(undefined, info)} /> }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the names are compared by what they say.
    [namesKey, shownKey, inUse, declared],
  );
  // A group that names all its parts takes no others.
  const open = rest !== false;
  // A record's properties are added to from the foot of its list.
  const addable = !parent && onChange !== undefined;

  return (
    <>
      {shown.map((name) => {
        const { info, suggestions, own } = describeProperty(name, declared, inUse, rest);
        const value = values[name];
        const set = !isEmptyValue(value);
        // A property the record does not have and no type asks for is only a row until it is given a value.
        const passing = !set && !own && !(name in values);
        const kind = propertyKind(value, info);
        // A switch cannot be emptied and a value with parts has no one control to empty it with: those come off by the row.
        const unclearable = kind === "boolean" || kind === "group" || kind === "items";
        const removable = onChange !== undefined && (set || passing || (parent !== undefined && name in values)) && (!own || (!info?.required && unclearable && name in values));
        return (
          <Row
            key={name}
            shared={shared}
            path={parent ? `${parent.path}.${name}` : name}
            name={name}
            label={parent ? `${parent.label} ${name}` : name}
            value={value}
            info={info}
            suggestions={suggestions}
            focus={focus === name}
            // What is typed for a property nothing describes is read for what it most plainly is.
            loose={passing}
            startOpen={revealed.includes(name)}
            onChange={
              onChange
                ? (next) => {
                    written.current.add(name);
                    onChange(name, next);
                  }
                : undefined
            }
            onDone={() => {
              if (focus === name) setFocus(null);
              if (passing && !written.current.has(name)) setRevealed((current) => current.filter((other) => other !== name));
            }}
            removeLabel={labels.removeProperty(parent ? `${parent.label} ${name}` : name)}
            onRemove={
              removable
                ? () => {
                    held.current.delete(name);
                    setRevealed((current) => current.filter((other) => other !== name));
                    if (name in values) onChange(name, null);
                  }
                : undefined
            }
          />
        );
      })}
      {!parent && !shown.length && !onChange && !empties ? <p className="mdbase-properties-none">{labels.noProperties}</p> : null}
      {adding && onChange ? (
        <Combo
          className="mdbase-property-add"
          label={parent ? labels.addPropertyTo(parent.label) : labels.addProperty}
          placeholder={open ? labels.findProperty : labels.findDeclaredProperty}
          options={candidates}
          newLabel={labels.newProperty}
          accepts={(text) => open && isPropertyName(text) && !hidden(text)}
          emptyMessage={open ? labels.propertyNameInvalid : labels.noMatches}
          autoFocus
          onCommit={(name) => reveal(name)}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {(addable && !adding) || empties ? (
        <div className="mdbase-properties-foot">
          {addable && !adding ? (
            <button type="button" className="mdbase-properties-action" onClick={() => setAdding(true)}>
              <Glyph name="plus" />
              {labels.addProperty}
            </button>
          ) : null}
          {empties ? (
            <button type="button" className="mdbase-properties-action is-toggle" aria-expanded={showEmpty} onClick={toggleEmpty}>
              {showEmpty ? labels.hideEmpty : labels.showEmpty(empties)}
              <Glyph name={showEmpty ? "up" : "down"} size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** One value and its name: a control for a value that stands alone, or the parts of one that has them, under it. */
function Row(props: {
  readonly shared: Shared;
  /** Where the value is in the record: `progress.page`, or `steps.0` for the first of a list. */
  readonly path: string;
  /** What the row is called beside its value. */
  readonly name: string;
  /** What the value's control is called: the name, after the names of what it is a part of. */
  readonly label: string;
  /** The name is the value's place in a list. */
  readonly counted?: boolean | undefined;
  readonly value: unknown;
  readonly info: PropertyInfo | undefined;
  readonly suggestions?: readonly string[] | undefined;
  /** Parts that the values beside this one have, offered when it is added to. */
  readonly inUse?: readonly PropertyInfo[] | undefined;
  readonly focus: boolean;
  readonly loose: boolean;
  /** Shown open whatever it holds: it was just asked for. */
  readonly startOpen: boolean;
  readonly onChange: ((value: unknown) => void) | undefined;
  readonly onDone: () => void;
  readonly removeLabel: string;
  /** Absent when the value cannot be taken away. */
  readonly onRemove: (() => void) | undefined;
}): JSX.Element {
  const { shared, path, name, label, value, info, onChange } = props;
  const { labels } = shared;
  /** A part of this value is being named: at once in a value added with no parts. */
  const [adding, setAdding] = useState(() => Boolean(props.focus) && isGroup(value) && Object.keys(value).length === 0);
  /** The place of a value just added to this list, which takes the keyboard. */
  const [added, setAdded] = useState<number | null>(null);
  const kind = propertyKind(value, info);
  const set = !isEmptyValue(value);
  const error = shared.errors[path];
  const parted = kind === "group" || kind === "items";
  const list = Array.isArray(value) ? value : noValues;
  const group = isGroup(value) ? value : noParts;
  const count = Array.isArray(value) ? value.length : Object.keys(group).length;
  const open = parted && (shared.folds.get(path) ?? (props.startOpen || valueCount(value, openAtMost + 1) <= openAtMost));
  // One of several values with parts is told from the others by the first thing it says in its own words: not a choice from a few.
  const chosen = (part: string): boolean => Boolean(info?.parts?.find((other) => other.name === part)?.options?.length);
  const lead = props.counted ? Object.entries(group).find(([part, inner]) => typeof inner === "string" && !chosen(part) && valueLine(inner, labels) !== undefined)?.[1] : undefined;
  const summary = count === 0 ? labels.empty : typeof lead === "string" ? valueLine(lead, labels)! : kind === "items" ? labels.itemCount(count) : labels.partCount(count);
  const parts = `mdbase-parts-${path}`;
  // A value that names all its parts and holds them all has no room for another.
  const roomy = kind === "items" || (kind === "group" && (info?.rest !== false || (info.parts ?? noProperties).some((part) => !(part.name in group))));
  const add = (): void => {
    shared.fold(path, true);
    if (kind === "group") setAdding(true);
    else {
      setAdded(list.length);
      // Without a type to say, a new value is like the ones the list has.
      onChange?.([...list, info?.items ? blankValue(info.items) : list.length && list.every(isGroup) ? {} : list.length && list.every(Array.isArray) ? [] : null]);
    }
  };
  return (
    <>
      <div className="mdbase-property" data-field={path} data-kind={kind} data-empty={set ? undefined : ""} data-invalid={error ? "" : undefined}>
        <span className="mdbase-property-name" data-counted={props.counted ? "" : undefined} title={info?.description ? `${name}: ${info.description}` : name}>
          <PropertyKindIcon kind={kind} />
          <span>{name}</span>
          {info?.required ? <abbr className="mdbase-property-required" title={labels.required}>*</abbr> : null}
        </span>
        <div className="mdbase-property-value">
          {parted ? (
            // Nothing to open in a value that holds nothing and cannot be added to.
            count === 0 && !onChange ? (
              <span className="mdbase-property-static is-empty">{labels.empty}</span>
            ) : (
              <button type="button" className="mdbase-property-fold" aria-expanded={open} aria-label={`${label}: ${summary}`} onClick={() => shared.fold(path, !open)}>
                <span>{summary}</span>
                <Glyph name={open ? "up" : "down"} size={12} />
              </button>
            )
          ) : (
            <PropertyValue
              name={label}
              value={value}
              info={info}
              kind={kind}
              suggestions={props.suggestions}
              labels={labels}
              records={shared.records}
              autoFocus={props.focus}
              loose={props.loose}
              onChange={onChange}
              onDone={props.onDone}
            />
          )}
        </div>
        {onChange && roomy ? (
          <button
            type="button"
            className="mdbase-property-more"
            aria-label={kind === "items" ? labels.addItemTo(label) : labels.addPropertyTo(label)}
            title={kind === "items" ? labels.addItem : labels.addProperty}
            onClick={add}
          >
            <Glyph name="plus" size={12} />
          </button>
        ) : null}
        {props.onRemove ? (
          <button type="button" className="mdbase-property-clear" aria-label={props.removeLabel} title={props.removeLabel} onClick={props.onRemove}>
            <Glyph name="close" size={12} />
          </button>
        ) : null}
        {error ? <p className="mdbase-property-error" role="alert">{error}</p> : null}
      </div>
      {/* A value that can be added to keeps its parts' place while it has none: a part being named or filled in is there. */}
      {open && (count > 0 || (kind === "group" && onChange !== undefined)) ? (
        <div className="mdbase-property-parts" id={parts} role="group" aria-label={label}>
          {kind === "items" ? (
            <Items shared={shared} parent={{ path, label }} list={list} info={info?.items} added={added} onAdded={setAdded} onChange={onChange} />
          ) : (
            <Rows
              shared={shared}
              parent={{ path, label }}
              values={group}
              declared={info?.parts ?? noProperties}
              inUse={props.inUse ?? noProperties}
              hidden={shownAlways}
              rest={info?.rest}
              adding={adding}
              onAdding={setAdding}
              onChange={
                onChange
                  ? (part, next) => {
                      const { [part]: _was, ...others } = group;
                      onChange(next === null ? others : { ...group, [part]: next });
                    }
                  : undefined
              }
            />
          )}
        </div>
      ) : null}
    </>
  );
}

/** A list's values one under another, each by its place: for values that are more than short text. */
function Items(props: {
  readonly shared: Shared;
  readonly parent: Parent;
  readonly list: readonly unknown[];
  /** What each value is, when the type says. */
  readonly info: PropertyInfo | undefined;
  /** The place of a value just added, which takes the keyboard. */
  readonly added: number | null;
  readonly onAdded: (place: number | null) => void;
  readonly onChange: ((value: unknown) => void) | undefined;
}): JSX.Element {
  const { shared, parent, list, info, added, onChange } = props;
  // Values with parts and no type to name them are offered the parts the others have: their names and
  // what they hold, not a choice among the few values one record happens to hold for them.
  const inUse = useMemo(() => (info ? noProperties : propertiesInUse(list.filter(isGroup)).map(({ options: _few, ...part }) => part)), [info, list]);
  return (
    <>
      {list.map((item, index) => {
        const place = String(index + 1);
        return (
          <Row
            // A list has nothing but places to tell its values apart by.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            shared={shared}
            path={`${parent.path}.${String(index)}`}
            name={place}
            label={`${parent.label} ${place}`}
            counted
            value={item}
            info={info ? { ...info, name: place } : undefined}
            focus={added === index}
            inUse={inUse}
            loose={!info}
            startOpen={added === index}
            onChange={onChange ? (next) => onChange(list.map((other, at) => (at === index ? next : other))) : undefined}
            onDone={() => {
              if (added === index) props.onAdded(null);
            }}
            removeLabel={shared.labels.removeItem(parent.label, index + 1)}
            onRemove={
              onChange
                ? () => {
                    props.onAdded(null);
                    onChange(list.filter((_other, at) => at !== index));
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}
