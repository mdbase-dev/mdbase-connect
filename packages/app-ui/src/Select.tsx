import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";

import {
  edgeOption,
  extendTypeahead,
  flattenOptions,
  stepOption,
  typeaheadOption,
  type FlatSelectOption,
  type SelectItems,
} from "./select-model.js";
import { SelectList } from "./SelectList.js";

export type { SelectItems, SelectOption, SelectOptionGroup } from "./select-model.js";
import { useSelectPopover } from "./popover.js";

type TriggerAttributes = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children" | "type" | "role"
>;

export interface SelectProps<Value extends string> extends TriggerAttributes {
  readonly value: Value | "";
  readonly options: SelectItems<Value>;
  readonly onChange: (value: Value) => void;
  /** Shown while the value matches no option, like a native select's disabled first option. */
  readonly placeholder?: string;
  /** The trigger button, for focusing the control from elsewhere. */
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * A styled single-choice dropdown following the ARIA select-only combobox pattern. The list
 * opens in the browser's top layer, so clipped or transformed containers (virtual rows, side
 * panels, menus) never cut it off, while it stays in the DOM beside its trigger: a click in
 * the list still counts as inside any menu that contains the select.
 */
export function Select<Value extends string>({
  value,
  options: items,
  onChange,
  placeholder,
  className,
  disabled,
  onKeyDown,
  onClick,
  ref,
  ...trigger
}: SelectProps<Value>): JSX.Element {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const options = flattenOptions(items);
  const selected = options.findIndex((option) => option.value === value);
  const state = useSelectState(options, selected, value, onChange, disabled, triggerRef);
  useSelectPopover(state.open, triggerRef, listRef, () => state.close(false));
  useLayoutEffect(() => {
    if (state.open && listRef.current) {
      revealOption(listRef.current, state.active);
    }
  }, [state.active, state.open]);
  const label = selected >= 0 ? options[selected]?.label : placeholder;
  return (
    <>
      <button
        {...trigger}
        ref={(node) => {
          triggerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        role="combobox"
        className={["mdbase-select", className].filter(Boolean).join(" ")}
        data-value={value}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={state.open}
        aria-controls={`${id}-list`}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            state.toggle();
          }
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) {
            state.onTriggerKey(event);
          }
        }}
      >
        <span className={selected >= 0 ? "mdbase-select-value" : "mdbase-select-value is-empty"}>
          {label ?? ""}
        </span>
        <svg className="mdbase-select-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      <SelectList
        id={id}
        listRef={listRef}
        items={items}
        selected={selected}
        active={state.active}
        open={state.open}
        label={trigger["aria-label"]}
        labelledBy={trigger["aria-labelledby"]}
        onActivate={state.setActive}
        onChoose={state.choose}
        onKeyDown={state.onListKey}
      />
    </>
  );
}

interface SelectState {
  readonly open: boolean;
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly close: (refocus: boolean) => void;
  readonly choose: (index: number) => void;
  readonly toggle: () => void;
  readonly onTriggerKey: (event: KeyboardEvent) => void;
  readonly onListKey: (event: KeyboardEvent) => void;
}

function useSelectState<Value extends string>(
  options: readonly FlatSelectOption<Value>[],
  selected: number,
  value: Value | "",
  onChange: (value: Value) => void,
  disabled: boolean | undefined,
  triggerRef: RefObject<HTMLButtonElement | null>,
): SelectState {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: "", at: 0 });
  const typeahead = (event: KeyboardEvent, from: number): number => {
    typed.current = extendTypeahead(typed.current, event.key, event.timeStamp);
    return typeaheadOption(options, typed.current.text, from);
  };
  const show = (index: number): void => {
    if (!disabled && options.length) {
      setActive(index);
      setOpen(true);
    }
  };
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) {
      triggerRef.current?.focus();
    }
  };
  const commit = (index: number): void => {
    const option = options[index];
    if (option && !option.disabled && option.value !== value) {
      onChange(option.value);
    }
  };
  const choose = (index: number): void => {
    if (options[index] && !options[index].disabled) {
      close(true);
      commit(index);
    }
  };
  const initial = (key: string): number =>
    selected >= 0 ? selected : edgeOption(options, key === "ArrowUp" ? "last" : "first");
  const onTriggerKey = (event: KeyboardEvent): void => {
    if (disabled) {
      return;
    }
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      show(initial(event.key));
    } else if (isPrintable(event)) {
      // Like a native select, typing on the closed control changes the value directly.
      commit(typeahead(event, selected));
    }
  };
  const moves: Readonly<Record<string, () => number>> = {
    ArrowDown: () => stepOption(options, active, 1),
    ArrowUp: () => stepOption(options, active, -1),
    Home: () => edgeOption(options, "first"),
    End: () => edgeOption(options, "last"),
    PageDown: () => stepPage(options, active, 1),
    PageUp: () => stepPage(options, active, -1),
  };
  const onListKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setActive(move());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
      }
      close(event.key === "Escape");
    } else if (isPrintable(event)) {
      const match = typeahead(event, active);
      setActive(match >= 0 ? match : active);
    }
  };
  return {
    open,
    active,
    setActive,
    close,
    choose,
    toggle: () => (open ? close(false) : show(initial("ArrowDown"))),
    onTriggerKey,
    onListKey,
  };
}

function stepPage(options: readonly FlatSelectOption[], from: number, direction: 1 | -1): number {
  let index = from;
  for (let step = 0; step < 8; step += 1) {
    index = stepOption(options, index, direction);
  }
  return index;
}

/**
 * Scrolls only the list to show an option. scrollIntoView would also scroll the panels the
 * list sits inside in the DOM, which the open list treats as the page moving and closes.
 */
function revealOption(list: HTMLElement, index: number): void {
  const option = list.querySelector<HTMLElement>(`[data-index="${String(index)}"]`);
  if (!option) {
    return;
  }
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

function isPrintable(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}
