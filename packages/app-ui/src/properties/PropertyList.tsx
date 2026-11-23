import { useMemo, useRef, useState, type JSX } from "react";

import { Combo } from "../Combo.js";
import { Glyph, type GlyphName } from "../glyphs.js";
import { useLocaleRevision } from "../i18n.js";
import { propertyLabels, type PropertyLabels } from "./labels.js";
import { describeProperty, isEmptyValue, isGroup, isPropertyName, isScalar, propertyKind, valueLine, type PropertyInfo, type PropertyKind } from "./model.js";
import { PropertyValue, type PropertyRecords } from "./PropertyValue.js";

const kindGlyphs: Record<PropertyKind, GlyphName> = {
  choice: "choice",
  boolean: "boolean",
  date: "date",
  number: "number",
  tags: "list",
  links: "link",
  text: "text",
  long: "text",
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
  /** Absent when the record cannot be changed: its properties are then only shown. A removed property is given null. */
  readonly onChange: ((name: string, value: unknown) => void) | undefined;
  /** Text to show in place of the shared catalogue's. */
  readonly labels?: Partial<PropertyLabels> | undefined;
}

const showEmptyKey = "mdbase:show-empty-properties";

function readShowEmpty(): boolean {
  try {
    return localStorage.getItem(showEmptyKey) === "1";
  } catch {
    return false;
  }
}

const shownAlways = (): boolean => false;

/**
 * A record's properties, each edited in place with the control its value calls for. Properties
 * that hold nothing stay out of the way until they are asked for: one at a time through "Add
 * property", or all at once.
 */
export function PropertyList(props: PropertyListProps): JSX.Element {
  useLocaleRevision();
  const labels = { ...propertyLabels(), ...props.labels };
  const { values, declared, onChange } = props;
  const inUse = props.inUse ?? [];
  const hidden = props.hidden ?? shownAlways;
  const [adding, setAdding] = useState(false);
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
  const lasting = (name: string): boolean => held.current.has(name) || revealed.includes(name);
  const shown = names.filter((name) => showEmpty || lasting(name));
  const empties = names.filter((name) => !lasting(name)).length;
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

  return (
    <div className="mdbase-properties">
      {shown.map((name) => {
        const { info, suggestions, own } = describeProperty(name, declared, inUse);
        const value = values[name];
        if (isGroup(value) && Object.keys(value).length) {
          // A value with parts of its own is shown part by part. Changing one is the work of the app that keeps it.
          return Object.entries(value).map(([part, inner]) => {
            const text = valueLine(inner, labels) ?? (isScalar(inner) && inner !== null ? String(inner) : undefined);
            return text === undefined ? null : (
              <div key={`${name}.${part}`} className="mdbase-property" data-field={`${name}.${part}`} data-kind="other">
                <span className="mdbase-property-name" title={`${name}.${part}`}>
                  <Glyph name={typeof inner === "number" ? "number" : "text"} />
                  <span>
                    {name} <i>{part}</i>
                  </span>
                </span>
                <div className="mdbase-property-value">
                  <span className="mdbase-property-static">{text}</span>
                </div>
              </div>
            );
          });
        }
        const kind = propertyKind(value, info);
        const set = !isEmptyValue(value);
        // A property the record does not have and no type asks for is only a row until it is given a value.
        const passing = !set && !own && !(name in values);
        return (
          <div key={name} className="mdbase-property" data-field={name} data-kind={kind} data-empty={set ? undefined : ""}>
            <span className="mdbase-property-name" title={name}>
              <PropertyKindIcon kind={kind} />
              <span>{name}</span>
            </span>
            <div className="mdbase-property-value">
              <PropertyValue
                name={name}
                value={value}
                info={info}
                kind={kind}
                suggestions={suggestions}
                labels={labels}
                records={props.records}
                autoFocus={focus === name}
                // What is typed for a property nothing describes is read for what it most plainly is.
                loose={passing}
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
              />
            </div>
            {onChange && (set || passing) && !own ? (
              <button
                type="button"
                className="mdbase-property-clear"
                aria-label={labels.removeProperty(name)}
                title={labels.removeProperty(name)}
                onClick={() => {
                  held.current.delete(name);
                  setRevealed((current) => current.filter((other) => other !== name));
                  if (name in values) onChange(name, null);
                }}
              >
                <Glyph name="close" size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
      {!shown.length && !onChange && !empties ? <p className="mdbase-properties-none">{labels.noProperties}</p> : null}
      {adding && onChange ? (
        <Combo
          className="mdbase-property-add"
          label={labels.addProperty}
          placeholder={labels.findProperty}
          options={candidates}
          newLabel={labels.newProperty}
          accepts={(text) => isPropertyName(text) && !hidden(text)}
          emptyMessage={labels.propertyNameInvalid}
          autoFocus
          onCommit={(name) => reveal(name)}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {(onChange && !adding) || empties ? (
        <div className="mdbase-properties-foot">
          {onChange && !adding ? (
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
    </div>
  );
}
