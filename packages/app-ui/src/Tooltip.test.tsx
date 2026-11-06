import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Tooltip } from "./Tooltip.js";

it("labels the existing button, keeps its semantics and replaces a native title", () => {
  const html = renderToStaticMarkup(<Tooltip label="Actions"><button title="Native hint" aria-label="Collection actions" aria-describedby="context" aria-haspopup="menu" disabled><svg /></button></Tooltip>);
  expect(html).toMatch(/^<button /u);
  expect(html).toContain('aria-label="Collection actions"');
  expect(html).toContain('aria-describedby="context"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain("title=");
  expect(html).not.toContain('role="tooltip"');
});

it("writes platform shortcut semantics without changing the button's contents", () => {
  const html = renderToStaticMarkup(<Tooltip label="Search" shortcut="mod+shift+k"><button><svg data-icon="search" /></button></Tooltip>);
  expect(html).toContain('aria-keyshortcuts="Control+shift+k"');
  expect(html).toContain('data-icon="search"');
});
// @vitest-environment jsdom
import "../test/dialog.js";
import { act } from "react";
import { createRoot } from "react-dom/client";

it("preserves the caller's name and description and links only the supplemental shortcut", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    for (const shortcut of ["mod+k", undefined]) {
      act(() => root.render(<><span id="context">Collection options</span><Tooltip key={shortcut ?? "none"} label="Actions" shortcut={shortcut}><button aria-label="Collection actions" aria-describedby="context"><svg /></button></Tooltip></>));
      const button = host.querySelector("button")!;
      act(() => button.focus());
      expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
      expect(button.getAttribute("aria-label")).toBe("Collection actions");
      const descriptions = button.getAttribute("aria-describedby")!.split(" ");
      expect(descriptions.map(id => document.getElementById(id)!.textContent)).toEqual(shortcut ? ["Collection options", "Ctrl+K"] : ["Collection options"]);
      act(() => button.blur());
      expect(button.getAttribute("aria-describedby")).toBe("context");
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
