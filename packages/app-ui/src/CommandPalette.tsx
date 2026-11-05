import { t } from "@lingui/core/macro";
import { useLocaleRevision } from "./i18n.js";
import { Dialog } from "./Dialog.js";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type RefObject, type ReactNode } from "react";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly icon?: ReactNode;
  /** Stable group ID; headings follow first appearance and may be presented by groupLabel. */
  readonly group: string;
  readonly keywords?: string | undefined;
  /** For example "mod+shift+f"; see shortcutLabel. */
  readonly shortcut?: string | undefined;
  readonly run: () => void;
  /** A variant run with Shift+Enter or Shift+click, such as opening beside the document. */
  readonly alternate?: { readonly label: string; readonly run: () => void } | undefined;
}

export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
}

/** "mod+shift+f" as the platform writes it: ⌘⇧F on Apple systems, Ctrl+Shift+F elsewhere. */
export function shortcutLabel(shortcut: string): string {
  if (/^[a-z] [a-z]$/iu.test(shortcut)) return shortcut.toUpperCase();
  const apple = isApplePlatform();
  return shortcut
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "mod": return apple ? "⌘" : "Ctrl";
        case "ctrl": return apple ? "⌃" : "Ctrl";
        case "shift": return apple ? "⇧" : "Shift";
        case "alt": return apple ? "⌥" : "Alt";
        default: return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(apple ? "" : "+");
}

const browseLimit = 6;
const searchLimit = 40;

/**
 * Without a query, show a few of each group (every command of the groups in `showAll`); with
 * one, show every command matching all its terms, grouped in their original order.
 */
export function matchingCommands(
  commands: readonly Command[],
  query: string,
  showAll: readonly string[] = []
): readonly Command[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    const counts = new Map<string, number>();
    return commands.filter((command) => {
      const count = counts.get(command.group) ?? 0;
      counts.set(command.group, count + 1);
      return showAll.includes(command.group) || count < browseLimit;
    });
  }
  const matches = commands.filter((command) => {
    const content = `${command.label} ${command.detail ?? ""} ${command.group} ${command.keywords ?? ""}`.toLocaleLowerCase();
    return terms.every((term) => content.includes(term));
  });
  const names = matches.filter(command => terms.every(term => command.label.toLocaleLowerCase().includes(term)));
  const selected = [...names, ...matches.filter(command => !names.includes(command))].slice(0, searchLimit);
  const groups = [...new Set(selected.map(({ group }) => group))];
  return groups.flatMap((group) => selected.filter((command) => command.group === group));
}

/**
 * Find or run anything: every mdbase app opens it with Mod+K. Typing filters commands; the
 * arrows move, Enter runs, Shift+Enter runs a command's alternate, Escape closes.
 */
export function CommandPalette({ open, commands, onClose, label = t({ message: "Commands" }), placeholder = t({ message: "Search commands" }), showAll, groupLabel, returnFocusRef, emptyState }: {
  readonly open: boolean;
  readonly commands: readonly Command[];
  readonly onClose: () => void;
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly showAll?: readonly string[] | undefined;
  /** Presentation only: translate headings without changing group or showAll IDs. */
  readonly groupLabel?: ((group: string) => string) | undefined;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly emptyState?: ReactNode;
}): JSX.Element | null {
  useLocaleRevision();
  return <Dialog open={open} title={label} onClose={onClose} returnFocusRef={returnFocusRef} className="mdbase-command-palette">
    <OpenCommandPalette open={open} commands={commands} onClose={onClose} label={label} placeholder={placeholder} showAll={showAll} groupLabel={groupLabel} returnFocusRef={returnFocusRef} emptyState={emptyState} />
  </Dialog>;
}

function OpenCommandPalette({ open, commands, onClose, label, placeholder, showAll, groupLabel, returnFocusRef, emptyState }: {
  readonly open: boolean;
  readonly commands: readonly Command[];
  readonly onClose: () => void;
  readonly label: string;
  readonly placeholder: string;
  readonly showAll?: readonly string[] | undefined;
  readonly groupLabel?: ((group: string) => string) | undefined;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly emptyState?: ReactNode;
}): JSX.Element {
  useLocaleRevision();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => matchingCommands(commands, query, showAll), [commands, query, showAll]);
  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  const run = (command: Command, alternate = false): void => {
    inputRef.current?.closest("dialog")?.close();
    returnFocusRef?.current?.focus({ preventScroll: true });
    onClose();
    (alternate && command.alternate ? command.alternate.run : command.run)();
  };
  const hintId = useId();
  return <>
      <label className="mdbase-command-search">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <span className="mdbase-visually-hidden">{placeholder}</span>
        <input
          ref={inputRef}
          data-autofocus
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${hintId}-results`}
          aria-activedescendant={matches[active] ? `${hintId}-${matches[active].id}` : undefined}
          onKeyDown={(event) => { if (!event.nativeEvent.isComposing) handleKeys(event, matches, active, setActive, run, onClose); }}
        />
      </label>
      <div id={`${hintId}-results`} className="mdbase-command-results" role="listbox" aria-label={t({ message: "Results" })} aria-describedby={hintId}>
        {matches.length > 0
          ? matches.map((command, index) => <Fragment key={command.id}>
            {command.group !== matches[index - 1]?.group
              ? <div className="mdbase-command-group" role="presentation">{groupLabel ? groupLabel(command.group) : command.group}</div>
              : null}
            <CommandRow id={`${hintId}-${command.id}`} command={command} active={index === active} onRun={run} />
          </Fragment>)
          : <div className="mdbase-command-empty" role="status">{emptyState ?? t({ message: "Nothing matches" })}</div>}
      </div>
      <footer className="mdbase-command-footer" id={hintId}>
        <span><kbd>↑</kbd><kbd>↓</kbd>  {t({ message: "to move" })}</span>
        <span><kbd>↵</kbd>  {t({ message: "to open" })}</span>
        {matches[active]?.alternate
          ? <span><kbd>{shortcutLabel("shift")}</kbd><kbd>↵</kbd> {matches[active].alternate.label.toLocaleLowerCase()}</span>
          : null}
        <span><kbd>{t({ message: "Esc" })}</kbd>  {t({ message: "to close" })}</span>
      </footer>
  </>;
}

function CommandRow({ id, command, active, onRun }: {
  readonly id: string;
  readonly command: Command;
  readonly active: boolean;
  readonly onRun: (command: Command, alternate?: boolean) => void;
}): JSX.Element {
  useLocaleRevision();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return <button id={id} ref={ref} tabIndex={-1} type="button" role="option" aria-selected={active} onMouseDown={event => event.preventDefault()} onClick={(event) => onRun(command, event.shiftKey)}>
    {command.icon && <span className="mdbase-command-icon" aria-hidden="true">{command.icon}</span>}
    <span className="mdbase-command-copy">
      <strong>{command.label}</strong>
      {command.detail ? <small>{command.detail}</small> : null}
    </span>
    {command.alternate && active
      ? <span className="mdbase-command-alternate">{shortcutLabel("shift")}↵ {command.alternate.label}</span>
      : null}
    {command.shortcut ? <kbd>{shortcutLabel(command.shortcut)}</kbd> : null}
  </button>;
}

function handleKeys(
  event: KeyboardEvent<HTMLInputElement>,
  matches: readonly Command[],
  active: number,
  setActive: (value: number) => void,
  run: (command: Command, alternate?: boolean) => void,
  close: () => void
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    setActive((active + direction + matches.length) % Math.max(1, matches.length));
  } else if (event.key === "Enter") {
    const command = matches[active];
    if (command) {
      event.preventDefault();
      run(command, event.shiftKey);
    }
  }
}
