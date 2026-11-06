import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Tooltip } from "./Tooltip.js";

it("labels the existing button, keeps its semantics and replaces a native title", () => {
  const html = renderToStaticMarkup(<Tooltip label="Actions"><button title="Native hint" aria-describedby="context" aria-haspopup="menu" disabled><svg /></button></Tooltip>);
  expect(html).toMatch(/^<button /u);
  expect(html).toContain('aria-label="Actions"');
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
