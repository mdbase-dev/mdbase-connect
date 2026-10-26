import { t } from "@lingui/core/macro";
// CodeMirror widgets share one quiet, keyboard-reachable action surface.
export function embedActions(path: string, name: string, open?: () => void): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "cm-embed-actions";
  if (open) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t`Open`;
    button.setAttribute("aria-label", t`Open ${name}`);
    button.addEventListener("click", (event) => { event.stopPropagation(); open(); });
    actions.append(button);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = t`Copy path`;
  copy.setAttribute("aria-label", t`Copy path for ${name}`);
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void (async () => {
      try {
        await navigator.clipboard.writeText(path);
        status.textContent = t`Path copied.`;
      } catch {
        status.textContent = t`Couldn’t copy the path. Clipboard access is unavailable.`;
      }
    })();
  });
  actions.append(copy, status);
  return actions;
}

export function focusEmbedOnPointer(region: HTMLElement) {
  region.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && !event.target.closest("button, audio, video, .cm-file-embed-pdf-viewer")) {
      region.focus({ preventScroll: true });
    }
  });
}
