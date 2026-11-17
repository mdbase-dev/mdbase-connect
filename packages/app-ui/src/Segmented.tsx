import { useId, useLayoutEffect, useRef, type JSX } from "react";

export interface SegmentedOption<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

export interface SegmentedProps<Value extends string> {
  readonly value: Value;
  readonly options: readonly SegmentedOption<Value>[];
  readonly onChange: (value: Value) => void;
  /** The radios' form name; generated when omitted. */
  readonly name?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-labelledby"?: string | undefined;
}

/**
 * A single choice among two to four short options that all stay in view, chosen in one
 * click. Use Select when there are more, or when their labels are long.
 */
export function Segmented<Value extends string>({
  value,
  options,
  onChange,
  name,
  disabled,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SegmentedProps<Value>): JSX.Element {
  const generatedName = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const optionKey = options.map((option) => option.value).join("\n");

  // The thumb takes the checked option's box. A new choice names the edge that leads, which
  // CSS moves first, so the thumb stretches on the way; anything else places it at once.
  const place = (chosen: boolean): void => {
    const group = groupRef.current!;
    const thumb = thumbRef.current!;
    const option = group.querySelector("input:checked")?.closest("label");
    const shown = !thumb.hidden;
    thumb.hidden = !option;
    if (!option) return;
    const left = `${String(option.offsetLeft)}px`;
    const right = `${String(group.clientWidth - option.offsetLeft - option.offsetWidth)}px`;
    if (thumb.style.left === left && thumb.style.right === right) return;
    if (chosen && shown) {
      group.dataset["moving"] = option.offsetLeft > parseFloat(thumb.style.left) ? "end" : "start";
    } else {
      delete group.dataset["moving"];
    }
    thumb.style.left = left;
    thumb.style.right = right;
  };
  useLayoutEffect(() => place(true), [value, optionKey]);
  // Fonts arriving, a locale change or a narrower container all move the options.
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => place(false));
    const group = groupRef.current!;
    observer.observe(group);
    for (const option of group.querySelectorAll(".mdbase-segmented-option")) observer.observe(option);
    return () => observer.disconnect();
  }, [optionKey]);

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      className={["mdbase-segmented", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      <span ref={thumbRef} className="mdbase-segmented-thumb" aria-hidden="true" hidden />
      {options.map((option) => (
        <label key={option.value} className="mdbase-segmented-option">
          <input
            type="radio"
            name={name ?? generatedName}
            value={option.value}
            checked={option.value === value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
