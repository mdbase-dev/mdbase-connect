import type { QuickOpenCommand } from "./QuickOpen";

export function buildQuickOpenCommands({
  onNewNote,
  listCollapsed,
  onToggleList,
  onShortcuts,
  vim,
  onToggleVim,
  hasDocument,
  propertiesOpen,
  onToggleProperties,
  backlinksOpen,
  onToggleBacklinks,
  onCheckNote,
  onCopyPath
}: {
  onNewNote: () => void;
  listCollapsed: boolean;
  onToggleList: () => void;
  onShortcuts: () => void;
  vim: boolean;
  onToggleVim: () => void;
  hasDocument: boolean;
  propertiesOpen: boolean;
  onToggleProperties: () => void;
  backlinksOpen: boolean;
  onToggleBacklinks: () => void;
  onCheckNote: () => void;
  onCopyPath: () => void;
}): QuickOpenCommand[] {
  const commands: QuickOpenCommand[] = [
    { id: "new-note", label: "New note", hint: "Create in this collection", run: onNewNote },
    { id: "toggle-list", label: listCollapsed ? "Show notes sidebar" : "Hide notes sidebar", hint: "⌘⇧L", run: onToggleList },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "?", run: onShortcuts },
    { id: "vim", label: vim ? "Turn off vim keybindings" : "Turn on vim keybindings", run: onToggleVim }
  ];
  if (hasDocument) commands.push(
    { id: "properties", label: propertiesOpen ? "Close note properties" : "Note properties", run: onToggleProperties },
    { id: "backlinks", label: backlinksOpen ? "Close backlinks" : "Backlinks", run: onToggleBacklinks },
    { id: "check-note", label: "Check note", run: onCheckNote },
    { id: "copy-path", label: "Copy note path", run: onCopyPath }
  );
  return commands;
}
