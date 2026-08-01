import { TrashIcon } from "./icons";
import type { ButtonHTMLAttributes } from "react";

export function InlineRemoveButton({ label, className = "", title = label, ...props }: {
  label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "type">) {
  return <button
    {...props}
    type="button"
    className={`icon-button inline-remove-button${className ? ` ${className}` : ""}`}
    aria-label={label}
    title={title}
  ><TrashIcon aria-hidden="true" /></button>;
}
