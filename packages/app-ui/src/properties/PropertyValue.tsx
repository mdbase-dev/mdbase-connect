import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import { Combo } from "../Combo.js";
import { DateField } from "../DatePicker.js";
import { Glyph } from "../glyphs.js";
import { useLocaleRevision } from "../i18n.js";
import { LinkPicker } from "../LinkPicker.js";
import { Select } from "../Select.js";
import { Switch } from "../Switch.js";
import { CommitArea, CommitInput } from "./fields.js";
import { propertyLabels, type PropertyLabels } from "./labels.js";
import { isLink, linkLabel, linkToPath, parseValue, pathToLink, valueLine, type PropertyInfo, type PropertyKind, type PropertyScalar } from "./model.js";

/** What the editors need to know about the other records, for properties that link to them. */
export interface PropertyRecords {
  /** A record's title and kind, when it is known. */
  describe(path: string): { readonly title: string; readonly detail?: string | undefined } | undefined;
  /** Records whose title matches what was typed, best first. */
  search(query: string): readonly { readonly path: string; readonly title: string; readonly detail?: string | undefined }[];
  /** Show the record. Without it a link is only named. */
  readonly open?: ((path: string) => void) | undefined;
}

const noRecords: PropertyRecords = { describe: () => undefined, search: () => [] };
/** The choice that clears the value: no option a type lists is this. */
const CLEAR = "\u0000";

export interface PropertyValueProps {
  /** The property's name, which also names its control. */
  readonly name: string;
  readonly value: unknown;
  readonly info: PropertyInfo | undefined;
  /** How to show the value: `propertyKind(value, info)`. */
  readonly kind: PropertyKind;
  /** Values worth offering for a property that may hold any text. */
  readonly suggestions?: readonly string[] | undefined;
  readonly records?: PropertyRecords | undefined;
  /** Put the keyboard in the control when it appears, opening it where there is something to open. */
  readonly autoFocus?: boolean | undefined;
  /** Read typed text for the value it most plainly means: a number, true or false. */
  readonly loose?: boolean | undefined;
  /** Absent when the value cannot be changed: it is then only shown. */
  readonly onChange: ((value: unknown) => void) | undefined;
  /** The control was left. */
  readonly onDone?: (() => void) | undefined;
  /** Text to show in place of the shared catalogue's. */
  readonly labels?: Partial<PropertyLabels> | undefined;
}

/** One property's value, edited in place with the control it calls for. */
export function PropertyValue(props: PropertyValueProps): JSX.Element {
  useLocaleRevision();
  const labels = { ...propertyLabels(), ...props.labels };
  const { value, info, onChange, name, kind } = props;
  const records = props.records ?? noRecords;
  const readOnly = (text: string | undefined): JSX.Element => (
    <span className={text ? "mdbase-property-static" : "mdbase-property-static is-empty"}>{text ?? labels.empty}</span>
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    // A choice asked for by name opens, so the next key chooses.
    if (props.autoFocus && !opened.current && trigger.current) {
      opened.current = true;
      trigger.current.focus({ preventScroll: true });
      trigger.current.click();
    }
  }, [props.autoFocus]);
  const typedValue = (typed: string): unknown => (typed.trim() === "" ? null : props.loose ? parseValue(typed) : typed);
  const line = (held: unknown): string | undefined => valueLine(held, labels);

  if (kind === "links") return <LinksValue name={name} value={value} labels={labels} records={records} onChange={onChange} />;
  if (!onChange) return readOnly(line(value) ?? (value === undefined || value === null ? undefined : typeof value === "string" ? value : JSON.stringify(value)));
  switch (kind) {
    case "choice": {
      const options = info?.options ?? [];
      const unset = value === undefined || value === null;
      const all = unset || value === "" || options.some((option) => option === value) ? options : [value as PropertyScalar, ...options];
      return (
        <Select
          ref={trigger}
          className="is-quiet mdbase-property-select"
          aria-label={name}
          value={unset ? "" : String(value)}
          placeholder={labels.empty}
          options={[...all.map((option) => ({ value: String(option), label: String(option) })), ...(unset ? [] : [{ value: CLEAR, label: labels.clearValue }])]}
          onChange={(picked) => onChange(picked === CLEAR ? null : (all.find((option) => String(option) === picked) ?? null))}
          onBlur={props.onDone}
        />
      );
    }
    case "boolean":
      return <Switch checked={value === true} onChange={(checked) => onChange(checked)} aria-label={name} />;
    case "tags":
      return (
        <TagsValue
          name={name}
          items={Array.isArray(value) ? value.map(String) : []}
          labels={labels}
          autoFocus={Boolean(props.autoFocus)}
          onChange={(items) => onChange(items.length ? items : value === undefined ? null : [])}
          onDone={props.onDone}
        />
      );
    case "number":
      return (
        <CommitInput
          className="mdbase-property-input"
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={labels.empty}
          label={name}
          inputMode="decimal"
          autoFocus={Boolean(props.autoFocus)}
          onCommit={(typed) => {
            const number = Number(typed);
            onChange(typed.trim() === "" ? null : Number.isFinite(number) ? number : typed);
          }}
          onDone={props.onDone}
        />
      );
    case "date":
      return (
        <DateField
          className="mdbase-property-date"
          value={typeof value === "string" ? value : ""}
          placeholder={labels.empty}
          label={name}
          labels={labels.date}
          defaultOpen={Boolean(props.autoFocus)}
          onChange={onChange}
          onClose={props.onDone}
        />
      );
    case "long":
      return <CommitArea className="mdbase-property-input" value={typeof value === "string" ? value : ""} placeholder={labels.empty} label={name} onCommit={(typed) => onChange(typed.trim() === "" ? null : typed)} />;
    case "text":
      return props.suggestions?.length ? (
        <Combo
          className="mdbase-property-combo"
          label={name}
          placeholder={labels.empty}
          value={typeof value === "string" ? value : ""}
          options={props.suggestions.map((option) => ({ value: option }))}
          newLabel={labels.useValue}
          emptyMessage={labels.noMatches}
          autoFocus={Boolean(props.autoFocus)}
          commitOnBlur
          onCommit={(typed) => {
            onChange(typedValue(typed));
            props.onDone?.();
          }}
          onCancel={props.onDone}
        />
      ) : (
        <CommitInput
          className="mdbase-property-input"
          value={typeof value === "string" ? value : ""}
          placeholder={labels.empty}
          label={name}
          autoFocus={Boolean(props.autoFocus)}
          onCommit={(typed) => onChange(typedValue(typed))}
          onDone={props.onDone}
        />
      );
    default:
      return readOnly(line(value) ?? JSON.stringify(value));
  }
}

/** A list of short values as chips: Enter or a comma adds one, Backspace takes the last away. */
function TagsValue(props: {
  readonly name: string;
  readonly items: readonly string[];
  readonly labels: PropertyLabels;
  readonly autoFocus: boolean;
  readonly onChange: (items: string[]) => void;
  readonly onDone: (() => void) | undefined;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.autoFocus) field.current?.focus({ preventScroll: true });
  }, [props.autoFocus]);
  const add = (): void => {
    const next = draft
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && !props.items.includes(item));
    setDraft("");
    if (next.length) props.onChange([...props.items, ...next]);
  };
  return (
    <div className="mdbase-tokens" data-editable="">
      {props.items.map((item) => (
        <span key={item} className="mdbase-token">
          {item}
          <button type="button" aria-label={props.labels.removeValue(item)} onClick={() => props.onChange(props.items.filter((other) => other !== item))}>
            <Glyph name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        ref={field}
        className="mdbase-tokens-input"
        value={draft}
        placeholder={props.items.length ? "" : props.labels.empty}
        aria-label={props.name}
        // In a popover the typing goes here, not to the first value's button.
        data-autofocus={props.autoFocus ? "" : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          add();
          props.onDone?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            event.stopPropagation();
            add();
          } else if (event.key === "Backspace" && !draft && props.items.length) {
            props.onChange(props.items.slice(0, -1));
          } else if (event.key === "Escape") {
            // Escape first gives up what is half typed; pressed again it is the host's to close on.
            if (draft) {
              event.stopPropagation();
              setDraft("");
            } else event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/** Links to other records as chips that open the record; more are found by typing. */
function LinksValue(props: {
  readonly name: string;
  readonly value: unknown;
  readonly labels: PropertyLabels;
  readonly records: PropertyRecords;
  readonly onChange: ((value: unknown) => void) | undefined;
}): JSX.Element {
  const { labels, records } = props;
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const single = !Array.isArray(props.value);
  const links = (Array.isArray(props.value) ? props.value : [props.value]).filter(isLink);
  const paths = links.map((link) => linkToPath(link));
  const options = useMemo(
    () => (picking ? records.search(query).filter((found) => !paths.includes(found.path)).slice(0, 30) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the paths are compared by what they say.
    [picking, query, records, paths.join("\n")],
  );
  const write = (next: string[]): void => props.onChange?.(next.length ? (single && next.length === 1 ? next[0] : next) : null);
  const open = records.open;
  return (
    <div className="mdbase-tokens" data-links="">
      {links.map((link, index) => {
        const path = paths[index] ?? null;
        const known = path === null ? undefined : records.describe(path);
        const title = known?.title ?? linkLabel(link);
        return (
          <span key={link} className="mdbase-token" data-link="" data-missing={known ? undefined : ""}>
            {open && path !== null ? (
              <button type="button" className="mdbase-token-open" title={path} onClick={() => open(path)}>
                {title}
              </button>
            ) : (
              <span className="mdbase-token-open" title={path ?? undefined}>{title}</span>
            )}
            {props.onChange ? (
              <button type="button" aria-label={labels.removeValue(title)} onClick={() => write(links.filter((other) => other !== link))}>
                <Glyph name="close" size={10} />
              </button>
            ) : null}
          </span>
        );
      })}
      {props.onChange ? (
        picking ? (
          <LinkPicker
            className="mdbase-property-link-picker"
            label={labels.linkRecord(props.name)}
            placeholder={labels.findRecord}
            query={query}
            onQueryChange={setQuery}
            options={options.map((found) => ({ id: found.path, title: found.title, ...(found.detail ? { detail: found.detail } : {}) }))}
            emptyMessage={labels.noMatches}
            autoFocus
            onPick={(option) => {
              write([...links, pathToLink(option.id)]);
              setQuery("");
              setPicking(false);
            }}
            onClose={() => {
              setQuery("");
              setPicking(false);
            }}
          />
        ) : (
          <button type="button" className="mdbase-token-add" data-autofocus="" aria-label={labels.linkRecord(props.name)} title={labels.linkRecord(props.name)} onClick={() => setPicking(true)}>
            <Glyph name="plus" size={12} />
          </button>
        )
      ) : null}
    </div>
  );
}
