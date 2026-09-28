import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  /** Commands show under their group's heading, in the order the groups first appear. */
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
  const apple = isApplePlatform();
  return shortcut
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "mod": return apple ? "⌘" : "Ctrl";
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
  const groups = [...new Set(matches.map(({ group }) => group))];
  return groups.flatMap((group) => matches.filter((command) => command.group === group)).slice(0, searchLimit);
}

/**
 * Find or run anything: every mdbase app opens it with Mod+K. Typing filters commands; the
 * arrows move, Enter runs, Shift+Enter runs a command's alternate, Escape closes.
 */
export function CommandPalette({ open, commands, onClose, label = "Commands", placeholder = "Search commands", showAll }: {
  readonly open: boolean;
  readonly commands: readonly Command[];
  readonly onClose: () => void;
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly showAll?: readonly string[] | undefined;
}): JSX.Element | null {
  return open ? <OpenCommandPalette commands={commands} onClose={onClose} label={label} placeholder={placeholder} showAll={showAll} /> : null;
}

function OpenCommandPalette({ commands, onClose, label, placeholder, showAll }: {
  readonly commands: readonly Command[];
  readonly onClose: () => void;
  readonly label: string;
  readonly placeholder: string;
  readonly showAll?: readonly string[] | undefined;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLElement>(null);
  const matches = useMemo(() => matchingCommands(commands, query, showAll), [commands, query, showAll]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    globalThis.setTimeout(() => inputRef.current?.focus(), 0);
    return () => previous?.focus();
  }, []);
  const run = (command: Command, alternate = false): void => {
    onClose();
    (alternate && command.alternate ? command.alternate.run : command.run)();
  };
  const hintId = `${label.replace(/\W+/gu, "-").toLowerCase()}-hint`;
  return <dialog className="mdbase-command-backdrop" open>
    <button className="mdbase-command-dismiss" type="button" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose} />
    <section
      ref={paletteRef}
      className="mdbase-command-palette"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Tab") {
          trapFocus(event, paletteRef.current);
        }
      }}
    >
      <label className="mdbase-command-search">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <span className="mdbase-visually-hidden">{placeholder}</span>
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => handleKeys(event, matches, active, setActive, run, onClose)}
        />
      </label>
      <div className="mdbase-command-results" role="listbox" aria-label="Results" aria-describedby={hintId}>
        {matches.length > 0
          ? matches.map((command, index) => <Fragment key={command.id}>
            {command.group !== matches[index - 1]?.group
              ? <div className="mdbase-command-group" role="presentation">{command.group}</div>
              : null}
            <CommandRow command={command} active={index === active} onRun={run} />
          </Fragment>)
          : <div className="mdbase-command-empty">Nothing matches</div>}
      </div>
      <footer className="mdbase-command-footer" id={hintId}>
        <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
        <span><kbd>↵</kbd> to open</span>
        {matches[active]?.alternate
          ? <span><kbd>{shortcutLabel("shift")}</kbd><kbd>↵</kbd> {matches[active].alternate.label.toLocaleLowerCase()}</span>
          : null}
        <span><kbd>Esc</kbd> to close</span>
      </footer>
    </section>
  </dialog>;
}

function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
  if (!container) return;
  const items = [...container.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function CommandRow({ command, active, onRun }: {
  readonly command: Command;
  readonly active: boolean;
  readonly onRun: (command: Command, alternate?: boolean) => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return <button ref={ref} type="button" role="option" aria-selected={active} onMouseDown={(event) => onRun(command, event.shiftKey)}>
    <span>
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
