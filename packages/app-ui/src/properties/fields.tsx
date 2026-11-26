import { useEffect, useRef, useState, type JSX } from "react";

/** A text field that keeps its own text while typed in and hands it over on Enter or when left. */
export function CommitInput(props: {
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly autoFocus?: boolean | undefined;
  readonly className: string;
  readonly inputMode?: "decimal" | "text" | undefined;
  /** A date and time in the reader's own zone, picked with the browser's control, in place of text. */
  readonly moment?: boolean | undefined;
  readonly title?: string | undefined;
  /** The text is how a value of another kind reads: Enter hands it over as typed though nothing was changed. */
  readonly restate?: boolean | undefined;
  readonly onCommit: (value: string) => void;
  readonly onDone?: (() => void) | undefined;
}): JSX.Element {
  const [text, setText] = useState(props.value);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => setText(props.value), [props.value]);
  useEffect(() => {
    if (props.autoFocus) {
      // The host decides what scrolls: a canvas must not shift under its camera.
      ref.current?.focus({ preventScroll: true });
      ref.current?.select();
    }
  }, [props.autoFocus]);
  return (
    <input
      ref={ref}
      className={props.className}
      data-autofocus={props.autoFocus ? "" : undefined}
      type={props.moment ? "datetime-local" : "text"}
      step={props.moment ? 1 : undefined}
      title={props.title}
      inputMode={props.inputMode}
      value={text}
      placeholder={props.placeholder}
      aria-label={props.label}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (!cancelled.current && text !== props.value) props.onCommit(text);
        cancelled.current = false;
        props.onDone?.();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        // The key ends the edit; it is not also the host's Enter or Escape.
        event.stopPropagation();
        if (event.key === "Escape") {
          cancelled.current = true;
          setText(props.value);
        } else if (props.restate && text === props.value) {
          props.onCommit(text);
        }
        event.currentTarget.blur();
      }}
    />
  );
}

/** A text area that grows with its text and commits as `CommitInput` does; Enter is a new line. */
export function CommitArea(props: {
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly className: string;
  readonly onCommit: (value: string) => void;
}): JSX.Element {
  const [text, setText] = useState(props.value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useEffect(() => setText(props.value), [props.value]);
  useEffect(() => {
    const element = ref.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${String(element.scrollHeight + 2)}px`;
    }
  }, [text]);
  return (
    <textarea
      ref={ref}
      className={props.className}
      rows={1}
      value={text}
      placeholder={props.placeholder}
      aria-label={props.label}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (!cancelled.current && text !== props.value) props.onCommit(text);
        cancelled.current = false;
      }}
      onKeyDown={(event) => {
        const done = event.key === "Enter" && (event.metaKey || event.ctrlKey);
        if (event.key !== "Escape" && !done) return;
        event.stopPropagation();
        if (event.key === "Escape") {
          cancelled.current = true;
          setText(props.value);
        }
        event.currentTarget.blur();
      }}
    />
  );
}
