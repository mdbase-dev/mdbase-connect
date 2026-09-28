export interface SelectOption<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

export interface SelectOptionGroup<Value extends string = string> {
  readonly label: string;
  readonly options: readonly SelectOption<Value>[];
}

export type SelectItems<Value extends string = string> = readonly (
  SelectOption<Value> | SelectOptionGroup<Value>
)[];

export interface FlatSelectOption<Value extends string = string> extends SelectOption<Value> {
  /** The group heading this option sits under, if any. */
  readonly group?: string | undefined;
}

export function isOptionGroup<Value extends string>(
  item: SelectOption<Value> | SelectOptionGroup<Value>,
): item is SelectOptionGroup<Value> {
  return "options" in item;
}

/** Options in display order, each remembering its group. */
export function flattenOptions<Value extends string>(
  items: SelectItems<Value>,
): readonly FlatSelectOption<Value>[] {
  return items.flatMap((item) =>
    isOptionGroup(item) ? item.options.map((option) => ({ ...option, group: item.label })) : [item],
  );
}

/** The next enabled option from `from` in `direction`, stopping at the ends like a native list. */
export function stepOption(
  options: readonly SelectOption[],
  from: number,
  direction: 1 | -1,
): number {
  for (let index = from + direction; index >= 0 && index < options.length; index += direction) {
    if (!options[index]?.disabled) {
      return index;
    }
  }
  return from;
}

/** The first (or last) enabled option, or -1 when every option is disabled. */
export function edgeOption(options: readonly SelectOption[], edge: "first" | "last"): number {
  const start = edge === "first" ? -1 : options.length;
  const found = stepOption(options, start, edge === "first" ? 1 : -1);
  return found === start ? -1 : found;
}

/**
 * Type-to-select: the next enabled option whose label starts with what was typed. Typing one
 * letter repeatedly cycles through the options that start with it, as a native select does.
 */
export function typeaheadOption(
  options: readonly SelectOption[],
  typed: string,
  from: number,
): number {
  const query = typed.toLocaleLowerCase();
  const prefix = /^(.)\1+$/su.test(query) ? query.slice(0, 1) : query;
  const offset = prefix.length === 1 ? 1 : 0;
  for (let step = 0; step < options.length; step += 1) {
    const index = (from + offset + step + options.length) % options.length;
    const option = options[index];
    if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) {
      return index;
    }
  }
  return -1;
}

/** Where each item's options start in the flattened list, so groups can render in place. */
export function itemOffsets<Value extends string>(items: SelectItems<Value>): readonly number[] {
  const offsets: number[] = [];
  let next = 0;
  for (const item of items) {
    offsets.push(next);
    next += isOptionGroup(item) ? item.options.length : 1;
  }
  return offsets;
}

export interface TypeaheadBuffer {
  readonly text: string;
  readonly at: number;
}

/** Appends a typed key, starting over after a pause, as native selects do. */
export function extendTypeahead(buffer: TypeaheadBuffer, key: string, at: number): TypeaheadBuffer {
  return { text: at - buffer.at > 600 ? key : buffer.text + key, at };
}
