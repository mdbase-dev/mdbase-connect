import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import { Combo } from "../Combo.js";
import { DateField, displayLocale, formatDay } from "../DatePicker.js";
import { Glyph } from "../glyphs.js";
import { useLocaleRevision } from "../i18n.js";
import { LinkPicker } from "../LinkPicker.js";
import { Select } from "../Select.js";
import { Switch } from "../Switch.js";
import { CommitArea, CommitInput } from "./fields.js";
import { propertyLabels, type PropertyLabels } from "./labels.js";
import { isLink, linkName, linkToPath, localMoment, parseValue, pathToLink, storedMoment, valueLine, type PropertyInfo, type PropertyKind, type PropertyScalar } from "./model.js";

/** A record as a link names it: its title, what kind of record it is, and a drawing for that kind. */
export interface PropertyRecord {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly icon?: ReactNode | undefined;
}

/** Where a record is being made from a property's picker, and how the link to it is written. */
export interface PropertyLinkCreation {
  /** The property the link is for. */
  readonly property: string;
  /** Where the property is on screen; nothing once it has gone. */
  anchor(): DOMRect | undefined;
  /** Writes the link to the record made. */
  link(path: string, title: string): void;
  /** Hands the keyboard back to the property. */
  restoreFocus(): void;
}

/** What the editors need to know about the other records, for properties that link to them. */
export interface PropertyRecords {
  /** A record's title and kind, when it is known. */
  describe(path: string): PropertyRecord | undefined;
  /**
   * Records whose title matches what was typed, best first. `property` is the one being filled
   * in, for a host that offers only the records its type allows there.
   */
  search(query: string, property?: string): readonly (PropertyRecord & { readonly path: string })[];
  /** Show the record. Without it a link is only named. */
  readonly open?: ((path: string) => void) | undefined;
  /**
   * The record a link's text leads to, for a host that asks the collection rather than reading
   * the text: undefined until it is known, null when the link leads nowhere.
   */
  readonly resolve?: ((link: string) => string | null | undefined) | undefined;
  /** The text to write for a link to a record. Without it the link is a wikilink. */
  readonly link?: ((path: string, title: string, property: string) => string) | undefined;
  /** The kinds of record that can be made from a property's picker, such as one for each type it may link to. */
  readonly creates?: ((property: string) => readonly { readonly id: string; readonly label: string }[]) | undefined;
  /** Makes a record of a kind `creates` offered, titled as typed, and links it through `creation.link`. */
  readonly create?: ((kind: string, title: string, creation: PropertyLinkCreation) => void) | undefined;
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

  if (kind === "links") return <LinksValue name={name} value={value} info={info} labels={labels} records={records} autoFocus={Boolean(props.autoFocus)} onChange={onChange} onDone={props.onDone} />;
  if (!onChange && kind === "datetime" && typeof value === "string") return readOnly(new Intl.DateTimeFormat(displayLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)));
  if (!onChange && kind === "date" && typeof value === "string") return readOnly(formatDay(value));
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
    case "tags": {
      // A list of numbers stays one: what is typed into it is read as a number where it is one.
      const numbers = info?.items ? info.items.kind === "number" : Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number");
      const typed = (item: string): string | number => (numbers && item.trim() !== "" && Number.isFinite(Number(item)) ? Number(item) : item);
      return (
        <TagsValue
          name={name}
          items={Array.isArray(value) ? value.map(String) : value === undefined || value === null || value === "" ? [] : [String(value)]}
          labels={labels}
          autoFocus={Boolean(props.autoFocus)}
          onChange={(items) => onChange(items.length ? items.map(typed) : value === undefined ? null : [])}
          onDone={props.onDone}
        />
      );
    }
    case "number":
      return (
        <CommitInput
          className="mdbase-property-input"
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={labels.empty}
          label={name}
          inputMode="decimal"
          restate={typeof value === "string" && value !== ""}
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
    case "datetime":
      return (
        <CommitInput
          className="mdbase-property-input"
          moment
          value={localMoment(value)}
          label={name}
          title={labels.localTime(Intl.DateTimeFormat().resolvedOptions().timeZone)}
          autoFocus={Boolean(props.autoFocus)}
          onCommit={(typed) => onChange(storedMoment(typed))}
          onDone={props.onDone}
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
          value={typeof value === "string" ? value : typeof value === "number" ? String(value) : ""}
          placeholder={labels.empty}
          label={name}
          restate={typeof value === "number"}
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

/**
 * Links to other records as chips that open the record; more are found by typing, and where the
 * host can make records, made from what was typed.
 */
function LinksValue(props: {
  readonly name: string;
  readonly value: unknown;
  readonly info: PropertyInfo | undefined;
  readonly labels: PropertyLabels;
  readonly records: PropertyRecords;
  readonly autoFocus: boolean;
  readonly onChange: ((value: unknown) => void) | undefined;
  readonly onDone: (() => void) | undefined;
}): JSX.Element {
  const { labels, records, name } = props;
  const [picking, setPicking] = useState(props.autoFocus);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const declared = props.info?.link;
  // A declared link is one or several as its type says; any other is as it is written.
  const single = declared ? !declared.many : !Array.isArray(props.value);
  const held = Array.isArray(props.value) ? props.value : props.value === undefined || props.value === null || props.value === "" ? [] : [props.value];
  // What a type calls a link is one however it is written; elsewhere only a whole wikilink is.
  const links = held.filter((item): item is string => (declared ? typeof item === "string" : isLink(item)));
  const leads = (link: string): string | null | undefined => (records.resolve ? records.resolve(link) : linkToPath(link));
  const paths = links.map(leads);
  const options = useMemo(
    () => (picking ? records.search(query, name).filter((found) => !paths.includes(found.path)).slice(0, 30) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the paths are compared by what they say.
    [picking, query, records, name, paths.join("\n")],
  );
  // A record made through a form is linked later: by then the property may hold other links.
  const latest = useRef(links);
  latest.current = links;
  const write = (next: readonly string[]): void => {
    // A declared link keeps the shape its type gives it; any other becomes a list once it holds two.
    const one = declared ? !declared.many : single && next.length === 1;
    props.onChange?.(next.length ? (one ? next[next.length - 1] : next) : declared?.many ? [] : null);
  };
  const add = (path: string, title: string): void => {
    const link = records.link ? records.link(path, title, name) : pathToLink(path);
    write(declared && !declared.many ? [link] : [...latest.current, link]);
  };
  const focusProperty = (): void => root.current?.querySelector<HTMLElement>("input, .mdbase-token-add, .mdbase-token button")?.focus({ preventScroll: true });
  const close = (): void => {
    setQuery("");
    setPicking(false);
    props.onDone?.();
  };
  const open = records.open;
  const creates = props.onChange && records.create ? (records.creates?.(name) ?? []) : [];
  // A property declared to link one record offers no second.
  const full = declared !== undefined && !declared.many && links.length > 0;
  return (
    <div ref={root} className="mdbase-tokens" data-links="">
      {links.map((link, index) => {
        const path = paths[index];
        const known = typeof path === "string" ? records.describe(path) : undefined;
        const title = known?.title ?? linkName(link);
        // A link still being looked up is not yet one that leads nowhere.
        const missing = records.resolve ? path === null : !known;
        return (
          <span key={link} className="mdbase-token" data-link="" data-missing={missing ? "" : undefined}>
            {open && typeof path === "string" ? (
              <button type="button" className="mdbase-token-open" title={path} onClick={() => open(path)}>
                {known?.icon ? <span className="mdbase-token-icon" aria-hidden="true">{known.icon}</span> : null}
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
      {!props.onChange ? (
        links.length ? null : <span className="mdbase-property-static is-empty">{labels.empty}</span>
      ) : picking ? (
        <LinkPicker
          className="mdbase-property-link-picker"
          label={labels.linkRecord(name)}
          placeholder={labels.findRecord}
          query={query}
          onQueryChange={setQuery}
          options={options.map((found) => ({ id: found.path, title: found.title, ...(found.detail ? { detail: found.detail } : {}), ...(found.icon ? { icon: found.icon } : {}) }))}
          creates={creates}
          createLabel={(create, title) => labels.createRecord(create.label, title)}
          emptyMessage={labels.noMatches}
          autoFocus
          onPick={(option) => {
            add(option.id, option.title);
            close();
          }}
          onCreate={(create, title) => {
            records.create?.(create.id, title, {
              property: name,
              anchor: () => root.current?.getBoundingClientRect(),
              link: (path, made) => add(path, made),
              restoreFocus: focusProperty,
            });
            close();
          }}
          onClose={close}
        />
      ) : full ? null : (
        <button
          type="button"
          className={links.length ? "mdbase-token-add" : "mdbase-token-add is-first"}
          data-autofocus=""
          aria-label={labels.linkRecord(name)}
          title={labels.linkRecord(name)}
          onClick={() => setPicking(true)}
        >
          {links.length ? <Glyph name="plus" size={12} /> : <span>{labels.empty}</span>}
        </button>
      )}
    </div>
  );
}
