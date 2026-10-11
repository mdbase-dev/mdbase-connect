import type { InputHTMLAttributes, JSX, ReactNode } from "react";

type InputAttributes = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "children">;

/** A native checkbox and its text in one label: the row is the 44px target,
 * the box keeps its own size. */
export function Checkbox({ children, ...input }: InputAttributes & { readonly children: ReactNode }): JSX.Element {
  return (
    <label className="mdbase-check">
      <input {...input} type="checkbox" className="mdbase-checkbox" />
      <span>{children}</span>
    </label>
  );
}

/** Related checkboxes under a legend, without the browser's fieldset outline. */
export function CheckboxGroup({ legend, disabled, children }: {
  readonly legend: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <fieldset className="mdbase-check-group" disabled={disabled}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
