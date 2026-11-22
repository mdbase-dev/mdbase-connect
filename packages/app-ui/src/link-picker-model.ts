import type { ReactNode } from "react";

/** A record that can be linked to. The app matches and ranks; the picker only shows. */
export interface LinkPickerOption {
  readonly id: string;
  readonly title: string;
  /** Quiet text beside the title: a type name or a path. */
  readonly detail?: string | undefined;
  readonly icon?: ReactNode;
}

/** A kind of record the picker can make from what was typed: a type, or a plain note. */
export interface LinkPickerCreate {
  readonly id: string;
  /** The action without the title, such as "New person". */
  readonly label: string;
  readonly icon?: ReactNode;
}

export type LinkPickerRow =
  | { readonly kind: "option"; readonly option: LinkPickerOption }
  | { readonly kind: "create"; readonly create: LinkPickerCreate; readonly title: string };

/**
 * What the picker lists for a query: the app's matches, then one row per kind of record that
 * can be made with the typed title. Nothing is offered to create while the field is empty or
 * when a match already carries exactly that title.
 */
export function linkPickerRows(
  query: string,
  options: readonly LinkPickerOption[],
  creates: readonly LinkPickerCreate[],
): readonly LinkPickerRow[] {
  const title = query.trim().replace(/\s+/gu, " ");
  const rows: LinkPickerRow[] = options.map((option) => ({ kind: "option", option }));
  if (!title || options.some((option) => sameTitle(option.title, title))) {
    return rows;
  }
  return [...rows, ...creates.map((create) => ({ kind: "create" as const, create, title }))];
}

export function linkPickerRowId(row: LinkPickerRow): string {
  return row.kind === "option" ? `option:${row.option.id}` : `create:${row.create.id}`;
}

function sameTitle(left: string, right: string): boolean {
  return left.trim().localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
