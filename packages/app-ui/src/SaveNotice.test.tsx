import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SaveNotice, saveToneSignal } from "./SaveNotice.js";

describe("SaveNotice", () => {
  it("lets only a confirmed save settle away", () => {
    expect(renderToStaticMarkup(<SaveNotice tone="saved" />)).toContain('class="mdbase-save-notice is-saved mdbase-settle"');
    expect(renderToStaticMarkup(<SaveNotice tone="attention" />)).toContain('class="mdbase-save-notice is-attention"');
    expect(renderToStaticMarkup(<SaveNotice tone="saving" label="Renaming links" />)).toContain(">Renaming links</span>");
  });

  it("reacts on the mark only when a save finishes or a problem appears", () => {
    expect(saveToneSignal("saving", "saved")).toBe("saved");
    expect(saveToneSignal("pending", "saved")).toBe("saved");
    expect(saveToneSignal("saved", "attention")).toBe("error");
    expect(saveToneSignal("saving", "attention")).toBe("error");
    expect(saveToneSignal(null, "saved")).toBeNull();
    expect(saveToneSignal(null, "attention")).toBeNull();
    expect(saveToneSignal("attention", "attention")).toBeNull();
    expect(saveToneSignal("attention", "saved")).toBeNull();
  });
});
