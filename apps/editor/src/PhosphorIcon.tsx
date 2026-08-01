import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import type { HTMLAttributes } from "react";
import { PHOSPHOR_ICON_NAMES } from "./phosphor-icon-names.generated";

const PHOSPHOR_ICON_NAME_SET = new Set<string>(PHOSPHOR_ICON_NAMES);
const ICON_ALIASES: Record<string, string> = {
  braces: "brackets-curly",
  "circle-alert": "warning-circle",
  "file-code-2": "file-code",
  "file-plus-2": "file-plus",
  "link-2": "link",
  "more-horizontal": "dots-three",
  "notebook-pen": "notebook",
  "panel-left": "sidebar-simple",
  search: "magnifying-glass",
  "settings-2": "gear-six",
  "trash-2": "trash",
  "undo-2": "arrow-counter-clockwise"
};

export function normalizePhosphorIconName(value?: string): string {
  if (!value) return "";
  const normalized = value
    .trim()
    .replace(/^phosphor:/i, "")
    .replace(/^ph-/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLocaleLowerCase();
  return ICON_ALIASES[normalized] ?? normalized;
}

export function isPhosphorIconName(value?: string): boolean {
  return PHOSPHOR_ICON_NAME_SET.has(normalizePhosphorIconName(value));
}

export function collectionTypeIcon(type?: CollectionTypeDescriptor): string | undefined {
  const collection = objectValue(type?.collection) ?? objectValue(objectValue(type?.definition)?.collection);
  const display = objectValue(collection?.display);
  return typeof display?.icon === "string" ? display.icon : undefined;
}

export function PhosphorIcon({ name, className = "", ...props }: {
  name?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children">) {
  const normalized = normalizePhosphorIconName(name);
  if (!PHOSPHOR_ICON_NAME_SET.has(normalized)) return null;
  return <i {...props} className={`ph ph-${normalized}${className ? ` ${className}` : ""}`} />;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export { PHOSPHOR_ICON_NAMES };
