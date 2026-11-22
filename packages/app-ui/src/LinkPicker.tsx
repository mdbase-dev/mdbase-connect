import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type Ref,
} from "react";

import {
  linkPickerRowId,
  linkPickerRows,
  type LinkPickerCreate,
  type LinkPickerOption,
  type LinkPickerRow,
} from "./link-picker-model.js";
import { useOverlay } from "./overlay.js";
import { useSelectPopover } from "./popover.js";

export { linkPickerRows } from "./link-picker-model.js";
export type { LinkPickerCreate, LinkPickerOption, LinkPickerRow } from "./link-picker-model.js";

export interface LinkPickerProps {
  /** The field's accessible name. */
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** The records matching `query`, best first. The app matches; the picker does not filter. */
  readonly options: readonly LinkPickerOption[];
  /** Kinds of record that can be made from the typed title, listed after the matches. */
  readonly creates?: readonly LinkPickerCreate[] | undefined;
  /** A create row's text. By default the kind's label, then the title in quotation marks. */
  readonly createLabel?: ((create: LinkPickerCreate, title: string) => string) | undefined;
  /** Shown in the open list when there is nothing to pick or create. */
  readonly emptyMessage: string;
  readonly disabled?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly className?: string | undefined;
  readonly onPick: (option: LinkPickerOption) => void;
  readonly onCreate?: ((create: LinkPickerCreate, title: string) => void) | undefined;
  /** Escape with the list already closed, or focus leaving the field. */
  readonly onClose?: (() => void) | undefined;
  /** The text field, for focusing the picker from elsewhere. */
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

/**
 * A text field that links to a record: type to find one, or make a new one of a given kind from
 * what was typed. Focus stays in the field (the ARIA editable combobox pattern) and the list
 * opens in the top layer, so side panels and scrolling rows never clip it.
 */
export function LinkPicker({
  label,
  placeholder,
  query,
  onQueryChange,
  options,
  creates = [],
  createLabel = quotedCreateLabel,
  emptyMessage,
  disabled,
  autoFocus,
  className,
  onPick,
  onCreate,
  onClose,
  ref,
}: LinkPickerProps): JSX.Element {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rows = linkPickerRows(query, options, onCreate ? creates : []);
  const rowKey = rows.map(linkPickerRowId).join("\n");
  const { ref: listRef, present } = useOverlay<HTMLDivElement>(open);
  useSelectPopover(open, inputRef, listRef, () => setOpen(false), { focusList: false, contentKey: rowKey });
  // The best match is one Enter away; a row that moved under the old index is not.
  useLayoutEffect(() => setActive(0), [rowKey]);
  useLayoutEffect(() => {
    if (open && listRef.current) {
      revealRow(listRef.current, active);
    }
  }, [active, open, listRef]);

  const choose = (row: LinkPickerRow | undefined): void => {
    if (!row) {
      return;
    }
    setOpen(false);
    if (row.kind === "option") {
      onPick(row.option);
    } else {
      onCreate?.(row.create, row.title);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else if (rows.length) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + rows.length) % rows.length);
      }
    } else if (event.key === "Enter") {
      if (open && rows[active]) {
        event.preventDefault();
        choose(rows[active]);
      }
    } else if (event.key === "Escape") {
      // Inside a dialog or panel, the first Escape closes only the list.
      event.stopPropagation();
      if (open) {
        event.preventDefault();
        setOpen(false);
      } else {
        onClose?.();
      }
    }
  };
  return (
    <div className={["mdbase-link-picker", className].filter(Boolean).join(" ")}>
      <input
        ref={(node) => {
          inputRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        className="mdbase-field mdbase-link-picker-input"
        type="text"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && rows[active] ? `${id}-row-${String(active)}` : undefined}
        autoComplete="off"
        spellCheck={false}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the picker opens because the person asked to add a link.
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onClose?.();
        }}
        onKeyDown={onKeyDown}
      />
      {present && (
        <div
          ref={listRef}
          id={`${id}-list`}
          className="mdbase-select-list mdbase-link-picker-list mdbase-overlay"
          data-open={open}
          popover="manual"
          role="listbox"
          aria-label={label}
          // A press in the list must not take the focus (and the list) away from the field.
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
        >
          {rows.map((row, index) => (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- keys reach rows through the focused field.
            <div
              key={linkPickerRowId(row)}
              id={`${id}-row-${String(index)}`}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className={rowClassName(row, index === active)}
              onPointerMove={() => {
                if (index !== active) {
                  setActive(index);
                }
              }}
              onClick={() => choose(row)}
            >
              <span className="mdbase-link-option-icon" aria-hidden="true">
                {row.kind === "option" ? row.option.icon : (row.create.icon ?? <PlusGlyph />)}
              </span>
              <span className="mdbase-link-option-title">
                {row.kind === "option" ? row.option.title : createLabel(row.create, row.title)}
              </span>
              {row.kind === "option" && row.option.detail && (
                <span className="mdbase-link-option-detail">{row.option.detail}</span>
              )}
            </div>
          ))}
          {!rows.length && <div className="mdbase-link-picker-empty">{emptyMessage}</div>}
        </div>
      )}
    </div>
  );
}

function quotedCreateLabel(create: LinkPickerCreate, title: string): string {
  return `${create.label} “${title}”`;
}

function rowClassName(row: LinkPickerRow, active: boolean): string {
  return [
    "mdbase-select-option",
    "mdbase-link-option",
    row.kind === "create" ? "is-create" : "",
    active ? "is-active" : "",
  ].filter(Boolean).join(" ");
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** Scrolls only the list; scrollIntoView would move the panels the field sits in. */
function revealRow(list: HTMLElement, index: number): void {
  const row = list.querySelector<HTMLElement>(`[data-index="${String(index)}"]`);
  if (!row) {
    return;
  }
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}
