import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";

type ButtonAttributes = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "role" | "aria-checked" | "onChange" | "children"
>;

export interface SwitchProps extends ButtonAttributes {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Text beside the switch. Without it, name the switch with aria-label or aria-labelledby. */
  readonly children?: ReactNode;
}

/**
 * A setting that is on or off and takes effect at once. For a choice that waits for a Save,
 * use Checkbox.
 */
export function Switch({ checked, onChange, children, className, onClick, ...button }: SwitchProps): JSX.Element {
  const control = (
    <button
      {...button}
      type="button"
      role="switch"
      aria-checked={checked}
      className={["mdbase-switch", className].filter(Boolean).join(" ")}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(!checked);
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
  if (children === undefined) return control;
  return (
    <label className="mdbase-switch-row">
      <span>{children}</span>
      {control}
    </label>
  );
}
