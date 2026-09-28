import { isOptionGroup, itemOffsets, type SelectItems } from "./select-model.js";

import type { JSX, KeyboardEvent, RefObject } from "react";

/**
 * The listbox half of a select. Focus stays on the listbox, which names its active option with
 * aria-activedescendant, so options take pointer input only; the keyboard goes to the list.
 */
export function SelectList<Value extends string>({
  id,
  listRef,
  items,
  selected,
  active,
  open,
  label,
  labelledBy,
  onActivate,
  onChoose,
  onKeyDown,
}: {
  readonly id: string;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly items: SelectItems<Value>;
  readonly selected: number;
  readonly active: number;
  readonly open: boolean;
  readonly label: string | undefined;
  readonly labelledBy: string | undefined;
  readonly onActivate: (index: number) => void;
  readonly onChoose: (index: number) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const offsets = itemOffsets(items);
  const option = (
    value: { readonly value: Value; readonly label: string; readonly disabled?: boolean },
    index: number,
  ): JSX.Element => (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- keys reach options through the focused listbox.
    <div
      key={value.value}
      id={`${id}-option-${String(index)}`}
      data-index={index}
      data-value={value.value}
      role="option"
      aria-selected={index === selected}
      aria-disabled={value.disabled ? true : undefined}
      className={index === active ? "mdbase-select-option is-active" : "mdbase-select-option"}
      onPointerMove={() => {
        if (!value.disabled && index !== active) {
          onActivate(index);
        }
      }}
      onClick={() => onChoose(index)}
    >
      {value.label}
    </div>
  );
  return (
    // Rows and cards own clicks and double-clicks; choosing here must not reach them.
    <div
      ref={listRef}
      id={`${id}-list`}
      className="mdbase-select-list"
      popover="manual"
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-activedescendant={open && active >= 0 ? `${id}-option-${String(active)}` : undefined}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {items.map((item, itemIndex) => {
        const first = offsets[itemIndex] ?? 0;
        return isOptionGroup(item) ? (
          <div key={`group:${item.label}`} role="group" aria-label={item.label}>
            <div className="mdbase-select-group" aria-hidden="true">
              {item.label}
            </div>
            {item.options.map((value, offset) => option(value, first + offset))}
          </div>
        ) : (
          option(item, first)
        );
      })}
    </div>
  );
}
