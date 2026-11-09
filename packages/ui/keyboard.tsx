import { t } from "@lingui/core/macro";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { type Command, shortcutLabel } from "@mdbase-dev/ui/command-palette";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";

export const navigationShortcuts = {
  home: "g h", collections: "g c", applications: "g a", computers: "g o", account: "g u",
  overview: "g v", storage: "g t", access: "g r", settings: "g s", activity: "g l"
} as const;

// An overlay retained for its exit animation no longer owns the keyboard.
const blockingOverlay = ["dialog[open]", "[role=dialog]", "[role=menu]", "[role=listbox]"]
  .map((selector) => `${selector}:not([data-open="false"], [data-open="false"] *)`).join(", ");

export function useConnectKeyboard({ commands, enabled, root, filter, listFocus, onShow }: {
  commands: readonly Command[];
  enabled: boolean;
  root: string;
  filter: string;
  listFocus: string;
  onShow?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const invoker = useRef<HTMLElement | null>(null);
  const show = () => {
    onShow?.();
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };
  const registry = useEffectEvent(() => commands);
  const openPalette = useEffectEvent(show);
  useEffect(() => {
    let prefixUntil = 0;
    const palette = (event: KeyboardEvent) => {
      if (!enabled || event.isComposing || event.repeat || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      const retained = document.querySelector<HTMLDialogElement>("dialog.mdbase-command-palette");
      if (retained) setOpen(retained.dataset.open === "false");
      else if (!document.querySelector(blockingOverlay)) openPalette();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!enabled || event.defaultPrevented || event.isComposing || event.repeat || event.altKey
        || document.querySelector(blockingOverlay)) { prefixUntil = 0; return; }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.matches(`${root} ${filter}`) && target instanceof HTMLInputElement && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        prefixUntil = 0;
        if (event.key === "Escape" && target.value) {
          event.preventDefault();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, "");
          target.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (event.key === "Escape" || event.key === "ArrowDown" || event.key === "Enter") {
          event.preventDefault();
          const row = target.closest("section")!.querySelector<HTMLElement>("[data-list-item]");
          const focus = row?.querySelector<HTMLElement>(listFocus) ?? row;
          focus?.focus();
          focus?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox]")) { prefixUntil = 0; return; }
      const key = event.key.toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      if ((!modifier && key === "?") || (event.ctrlKey && !event.metaKey && key === "/")) {
        event.preventDefault(); prefixUntil = 0; setHelpOpen(true); return;
      }
      if (modifier || event.shiftKey && key !== "j" && key !== "k") { prefixUntil = 0; return; }
      const shortcut = Date.now() < prefixUntil ? `g ${key}` : key;
      prefixUntil = 0;
      if (shortcut === "r") {
        const item = target?.closest("[data-list-item]")?.getAttribute("data-command");
        const rename = item?.startsWith("collection:") ? `rename:${item.slice("collection:".length)}` : item?.startsWith("computer:") ? `rename-computer:${item.slice("computer:".length)}` : undefined;
        const command = registry().find(command => command.id === rename);
        if (command) { event.preventDefault(); command.run(); }
        return;
      }
      const command = registry().find(command => command.shortcut?.toLowerCase() === shortcut);
      if (command) { event.preventDefault(); command.run(); return; }
      if (key === "g") { event.preventDefault(); prefixUntil = Date.now() + 1000; return; }
      if (key === "/") {
        const input = document.querySelector<HTMLInputElement>(`${root} ${filter}`);
        if (input) { event.preventDefault(); input.focus(); }
      }
      if (key === "j" || key === "k") {
        const rows = [...document.querySelectorAll<HTMLElement>(`${root} [data-list-item]`)];
        if (!rows.length) return;
        const current = rows.findIndex(row => row.contains(document.activeElement));
        const index = current < 0 ? key === "j" ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (key === "j" ? 1 : -1)));
        const row = rows[index];
        const focus = row.querySelector<HTMLElement>(listFocus) ?? row;
        event.preventDefault(); focus.focus(); focus.scrollIntoView({ block: "nearest" });
      }
      if (key === "enter" && target?.matches("[data-list-item]")) {
        event.preventDefault(); target.querySelector<HTMLElement>("button, a")?.focus();
      }
    };
    window.addEventListener("keydown", palette, true);
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", palette, true); window.removeEventListener("keydown", keydown); };
  }, [enabled, root, filter, listFocus]);
  return { open, close: () => setOpen(false), show, helpOpen, showHelp: () => setHelpOpen(true), closeHelp: () => setHelpOpen(false), invoker, filter: `${root} ${filter}` };
}

export function KeyboardShortcuts({ keyboard, commands }: {
  keyboard: ReturnType<typeof useConnectKeyboard>;
  commands: readonly Command[];
}) {
  useLocaleRevision();
  return <Dialog open={keyboard.helpOpen} className="connect-shortcut-help" title={t(i18n)({ message: "Keyboard shortcuts", context: "Connect keyboard shortcuts" })} onClose={keyboard.closeHelp}>
    <p className="connect-muted">{t(i18n)({ message: "Shortcuts are off while typing or while a dialog is open.", context: "Connect keyboard shortcuts" })}</p>
    <dl className="connect-shortcuts">
      <div><dt>{t(i18n)({ message: "Search", context: "Connect keyboard shortcuts" })}</dt><dd><kbd>{shortcutLabel("mod+k")}</kbd></dd></div>
      {commands.filter(command => command.shortcut && command.shortcut !== "r").map(command => <div key={command.id}><dt>{command.label}</dt><dd><kbd>{shortcutLabel(command.shortcut!)}</kbd>{command.id === "shortcuts" && <> / <kbd>{shortcutLabel("Ctrl+/")}</kbd></>}</dd></div>)}
      {keyboard.helpOpen && document.querySelector(keyboard.filter) && <div><dt>{t(i18n)({ message: "Filter the current list", context: "Connect keyboard shortcuts" })}</dt><dd><kbd>/</kbd></dd></div>}
      <div><dt>{t(i18n)({ message: "Move through the list", context: "Connect keyboard shortcuts" })}</dt><dd><kbd>{shortcutLabel("j")}</kbd> / <kbd>{shortcutLabel("k")}</kbd></dd></div>
      <div><dt>{t(i18n)({ message: "Open the focused item", context: "Connect keyboard shortcuts" })}</dt><dd><kbd>{shortcutLabel("Enter")}</kbd></dd></div>
      {commands.some(command => command.id.startsWith("rename:") || command.id.startsWith("rename-computer:")) && <div><dt>{t(i18n)({ message: "Rename a hosted collection or computer", context: "Connect keyboard shortcuts" })}</dt><dd><kbd>{shortcutLabel("r")}</kbd></dd></div>}
    </dl>
  </Dialog>;
}
