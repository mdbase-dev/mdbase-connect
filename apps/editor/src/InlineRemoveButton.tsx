import { TrashIcon, XIcon } from "./icons";
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

/** The small × that takes one chip out of a set. */
export function ChipRemoveButton({ label, ...props }: {
  label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "type" | "className">) {
  return <button {...props} type="button" className="chip-remove-button" aria-label={label} title={label}><XIcon aria-hidden="true" /></button>;
}
