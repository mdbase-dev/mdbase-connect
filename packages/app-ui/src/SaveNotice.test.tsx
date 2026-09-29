import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SaveNotice } from "./SaveNotice.js";

describe("SaveNotice", () => {
  it("lets only a confirmed save settle away", () => {
    expect(renderToStaticMarkup(<SaveNotice tone="saved" />)).toContain('class="mdbase-save-notice is-saved mdbase-settle"');
    expect(renderToStaticMarkup(<SaveNotice tone="attention" />)).toContain('class="mdbase-save-notice is-attention"');
    expect(renderToStaticMarkup(<SaveNotice tone="saving" label="Renaming links" />)).toContain(">Renaming links</span>");
  });
});
