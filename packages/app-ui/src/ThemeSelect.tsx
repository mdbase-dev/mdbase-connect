import type { JSX } from "react";

import { Select } from "./Select.js";
import { themePreferences, type ThemePreference } from "./theme.js";

const themeLabels: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };
const themeOptions = themePreferences.map((value) => ({ value, label: themeLabels[value] }));

/**
 * The one control for choosing System, Light or Dark. The app owns the preference (with
 * loadThemePreference and saveThemePreference) because commands and menus may change it too.
 */
export function ThemeSelect({ value, onChange, className, label = "Color theme" }: {
  readonly value: ThemePreference;
  readonly onChange: (value: ThemePreference) => void;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
}): JSX.Element {
  return <Select aria-label={label} className={className} value={value} options={themeOptions} onChange={onChange} />;
}
