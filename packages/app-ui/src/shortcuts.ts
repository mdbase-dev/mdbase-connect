import { t } from "@lingui/core/macro";

export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
}

export function shortcutLabel(shortcut: string): string {
  if (/^[a-z] [a-z]$/iu.test(shortcut)) return shortcut.toUpperCase();
  const apple = isApplePlatform();
  return shortcut.split("+").map(part => {
    switch (part.toLowerCase()) {
      case "mod": return apple ? "⌘" : "Ctrl";
      case "ctrl": return apple ? "⌃" : "Ctrl";
      case "shift": return apple ? "⇧" : "Shift";
      case "alt": return apple ? "⌥" : "Alt";
      case "arrowdown": return "↓";
      case "arrowup": return "↑";
      case "arrowleft": return "←";
      case "arrowright": return "→";
      case "contextmenu": return t({ message: "Menu" });
      default: return part.length === 1 ? part.toUpperCase() : part;
    }
  }).join(apple ? "" : "+");
}
