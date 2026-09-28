import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppSwitcher } from "./AppSwitcher.js";

describe("AppSwitcher", () => {
  it("shows the current app's wordmark as a closed menu button", () => {
    const markup = renderToStaticMarkup(<AppSwitcher current="writer" />);

    expect(markup).toContain('aria-label="mdbase writer: open this collection in another app"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('class="mdbase-app-mark is-writer wordmark-mark"');
    expect(markup).not.toContain('role="menu"');
  });
});
