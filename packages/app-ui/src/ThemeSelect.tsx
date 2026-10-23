import { t } from "@lingui/core/macro";
import { useLocaleRevision } from "./i18n.js";
import type { JSX } from "react";

import { Select } from "./Select.js";
import { themePreferences, type ThemePreference } from "./theme.js";

const themeLabels: Record<ThemePreference, string> = { get system() { return t({ message: "System", context: "Color theme" }); }, get light() { return t({ message: "Light", context: "Color theme" }); }, get dark() { return t({ message: "Dark", context: "Color theme" }); } };
const themeOptions = () => themePreferences.map((value) => ({ value, label: themeLabels[value] }));

/**
 * The one control for choosing System, Light or Dark. The app owns the preference (with
 * loadThemePreference and saveThemePreference) because commands and menus may change it too.
 */
export function ThemeSelect({ value, onChange, className, label = t({ message: "Color theme", context: "Color theme" }) }: {
  readonly value: ThemePreference;
  readonly onChange: (value: ThemePreference) => void;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
}): JSX.Element {
  useLocaleRevision();
  return <Select aria-label={label} className={className} value={value} options={themeOptions()} onChange={onChange} />;
}
