import { CaretDownIcon as CaretDown } from "./icons";
import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type SelectHTMLAttributes
} from "react";

export const SelectControl = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & {
  containerClassName?: string;
  variant?: "field" | "compact";
}>(function SelectControl({
  children,
  className = "",
  containerClassName = "",
  disabled,
  variant = "field",
  ...props
}, ref) {
  return <span className={[
    "select-control",
    variant === "compact" ? "compact" : "",
    disabled ? "disabled" : "",
    containerClassName
  ].filter(Boolean).join(" ")}>
    <select {...props} ref={ref} className={className} disabled={disabled}>{children}</select>
    <CaretDown aria-hidden="true" />
  </span>;
});

export function ComboboxInput({
  label,
  listLabel = `${label} suggestions`,
  value,
  options,
  emptyMessage = "No matches.",
  containerClassName = "",
  onValueChange,
  onOptionSelect,
  onInputBlur,
  onInputKeyDown,
  ...inputProps
}: Omit<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "onBlur" | "onChange" | "onKeyDown" | "onSelect" | "role" | "value"> & {
  label: string;
  listLabel?: string;
  value: string;
  options: readonly string[];
  emptyMessage?: string;
  containerClassName?: string;
  onValueChange: (value: string) => void;
  onOptionSelect?: (value: string) => void;
  onInputBlur?: () => void;
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropUp, setDropUp] = useState(false);
  const uniqueOptions = useMemo(() => [...new Set(options)], [options]);
  const matches = useMemo(() => {
    const search = value.trim().toLocaleLowerCase();
    return uniqueOptions.filter((option) => !search || option.toLocaleLowerCase().includes(search));
  }, [uniqueOptions, value]);
  const hasOptions = uniqueOptions.length > 0;

  useEffect(() => {
    if (!hasOptions) setOpen(false);
  }, [hasOptions]);

  function openList(input: HTMLInputElement) {
    const bounds = input.getBoundingClientRect();
    setDropUp(window.innerHeight - bounds.bottom < 180 && bounds.top > 180);
    setOpen(true);
  }

  function choose(option: string) {
    onValueChange(option);
    onOptionSelect?.(option);
    setOpen(false);
    setActiveIndex(-1);
  }

  return <div
    className={`combobox-control${containerClassName ? ` ${containerClassName}` : ""}`}
  >
    <input
      {...inputProps}
      role={hasOptions ? "combobox" : undefined}
      aria-label={label}
      aria-autocomplete={hasOptions ? "list" : undefined}
      aria-expanded={hasOptions ? open : undefined}
      aria-controls={hasOptions ? listId : undefined}
      aria-activedescendant={hasOptions && open && activeIndex >= 0 && matches[activeIndex]
        ? `${listId}-${activeIndex}`
        : undefined}
      value={value}
      autoComplete="off"
      onFocus={(event) => {
        setActiveIndex(-1);
        if (hasOptions) openList(event.currentTarget);
        inputProps.onFocus?.(event);
      }}
      onClick={(event) => {
        if (hasOptions) openList(event.currentTarget);
        inputProps.onClick?.(event);
      }}
      onChange={(event) => {
        onValueChange(event.target.value);
        setActiveIndex(-1);
        if (hasOptions) openList(event.currentTarget);
      }}
      onBlur={() => {
        setOpen(false);
        setActiveIndex(-1);
        onInputBlur?.();
      }}
      onKeyDown={(event) => {
        if (hasOptions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          if (!open) {
            openList(event.currentTarget);
            setActiveIndex(event.key === "ArrowDown" ? 0 : Math.max(0, matches.length - 1));
          } else {
            setActiveIndex((current) => {
              if (!matches.length) return -1;
              if (event.key === "ArrowDown") return Math.min(current + 1, matches.length - 1);
              return current < 0 ? matches.length - 1 : Math.max(0, current - 1);
            });
          }
          return;
        }
        if (hasOptions && event.key === "Home" && open) {
          event.preventDefault();
          setActiveIndex(matches.length ? 0 : -1);
          return;
        }
        if (hasOptions && event.key === "End" && open) {
          event.preventDefault();
          setActiveIndex(matches.length - 1);
          return;
        }
        if (hasOptions && event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          setActiveIndex(-1);
          return;
        }
        if (hasOptions && event.key === "Enter" && open && activeIndex >= 0 && matches[activeIndex]) {
          event.preventDefault();
          choose(matches[activeIndex]);
          return;
        }
        onInputKeyDown?.(event);
      }}
    />
    {hasOptions && open && <div
      className={`combobox-popover${dropUp ? " drop-up" : ""}`}
      id={listId}
      role="listbox"
      aria-label={listLabel}
    >
      {matches.map((option, index) => <button
        id={`${listId}-${index}`}
        type="button"
        role="option"
        aria-selected={value === option}
        className={activeIndex === index ? "active" : ""}
        key={option}
        onMouseEnter={() => setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(option)}
      >{option}</button>)}
      {!matches.length && <p>{emptyMessage}</p>}
    </div>}
  </div>;
}
