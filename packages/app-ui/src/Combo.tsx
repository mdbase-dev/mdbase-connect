import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import { LinkPicker } from "./LinkPicker.js";

export interface ComboOption {
  /** What is handed back when the row is chosen. */
  readonly value: string;
  /** What the row says, when that is not the value. */
  readonly label?: string | undefined;
  /** Quiet text beside it. */
  readonly detail?: string | undefined;
  readonly icon?: ReactNode;
}

export interface ComboProps {
  /** Names the field for assistive technology. */
  readonly label: string;
  readonly placeholder?: string | undefined;
  /** The text the field starts with. */
  readonly value?: string | undefined;
  readonly options: readonly ComboOption[];
  /**
   * The row offered for text that is none of the options, such as "New property" or "Use": it is
   * followed by the text in quotation marks. Without it only the options can be chosen.
   */
  readonly newLabel?: string | undefined;
  /** Whether typed text may be taken as it is. Every text may, when this is absent. */
  readonly accepts?: ((text: string) => boolean) | undefined;
  /** Shown when nothing matches and the text cannot be taken. */
  readonly emptyMessage: string;
  readonly autoFocus?: boolean | undefined;
  readonly className?: string | undefined;
  /** Hand over what was typed when the field is left, as a text field would. */
  readonly commitOnBlur?: boolean | undefined;
  /** `made` says the value is typed text, not one of the options. */
  readonly onCommit: (value: string, made: boolean) => void;
  /** The field was left, or Escape was pressed, with nothing chosen. */
  readonly onCancel?: (() => void) | undefined;
}

const rank = (option: ComboOption, needle: string): number => {
  const text = (option.label ?? option.value).toLowerCase();
  return text === needle ? 0 : text.startsWith(needle) ? 1 : text.includes(needle) ? 2 : -1;
};

/**
 * A text field with a list under it: type to narrow the list, choose a row, or take what was
 * typed. It is the link picker, which finds or makes a record the same way, given plain values
 * to find and make. Every string is passed in.
 */
export function Combo(props: ComboProps): JSX.Element {
  const start = props.value ?? "";
  const [query, setQuery] = useState(start);
  // The value changed some other way (an undo, another editor): show what it is now.
  useEffect(() => setQuery(start), [start]);
  /** How the field's last use ended, so leaving it afterwards does not end it again. */
  const ended = useRef<"chosen" | "cancelled" | null>(null);
  const needle = query.trim().toLowerCase();
  const options = useMemo(() => {
    // Until something is typed over it, the text the field starts with is not a search.
    if (!needle || query === start) return props.options.slice(0, 80);
    return props.options
      .map((option) => ({ option, at: rank(option, needle) }))
      .filter((found) => found.at >= 0)
      .sort((a, b) => a.at - b.at)
      .slice(0, 80)
      .map((found) => found.option);
  }, [props.options, needle, query, start]);
  const usable = Boolean(props.newLabel) && query.trim() !== "" && (props.accepts?.(query.trim()) ?? true);
  const commit = (value: string, made: boolean): void => {
    ended.current = "chosen";
    setQuery(value);
    props.onCommit(value, made);
  };

  return (
    <div
      className={["mdbase-combo", props.className].filter(Boolean).join(" ")}
      onKeyDownCapture={(event) => {
        // Escape gives the field up; the picker reports it as it reports the focus leaving.
        if (event.key === "Escape") ended.current = "cancelled";
      }}
    >
      <LinkPicker
        label={props.label}
        placeholder={props.placeholder}
        query={query}
        onQueryChange={(text) => {
          ended.current = null;
          setQuery(text);
        }}
        options={options.map((option) => ({ id: option.value, title: option.label ?? option.value, ...(option.detail ? { detail: option.detail } : {}), ...(option.icon ? { icon: option.icon } : {}) }))}
        creates={usable ? [{ id: "new", label: props.newLabel! }] : []}
        emptyMessage={props.emptyMessage}
        autoFocus={props.autoFocus}
        onPick={(option) => commit(option.id, false)}
        onCreate={(_create, title) => commit(title.trim(), true)}
        onClose={() => {
          const how = ended.current;
          ended.current = null;
          if (how === "chosen") return;
          const typed = query.trim();
          if (how !== "cancelled" && props.commitOnBlur && typed !== start.trim()) {
            const known = props.options.find((option) => option.value === typed || option.label === typed);
            if (known) props.onCommit(known.value, false);
            else if (typed === "" || usable) props.onCommit(typed, true);
            else props.onCancel?.();
            return;
          }
          if (how === "cancelled") setQuery(start);
          props.onCancel?.();
        }}
      />
    </div>
  );
}
