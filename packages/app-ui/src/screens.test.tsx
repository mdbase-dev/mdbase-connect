import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConnectLayout, OpeningScreen } from "./screens.js";

describe("screens", () => {
  it("opens with the app's mark and name and turns a failure into a retry", () => {
    const opening = renderToStaticMarkup(<OpeningScreen app="reader" title="Opening collection" detail="Reading its sources" />);
    expect(opening).toContain('aria-busy="true"');
    expect(opening).toContain("mdbase-app-mark is-reader mdbase-motion-scan");
    expect(opening).toContain("mdbase <strong>reader</strong>");
    expect(opening).toContain('<div role="status"><p>Opening collection</p><small>Reading its sources</small></div>');
    expect(opening).toContain('<p role="alert"></p>');
    const failed = renderToStaticMarkup(<OpeningScreen app="writer" title="Opening" error="Connect is unavailable" onRetry={() => {}} />);
    expect(failed).toContain('data-loading-state="failed"');
    expect(failed).toContain('<p role="alert">Connect is unavailable</p>');
    expect(failed).toContain("Try again");
  });

  it("leaves recovery to an embedding gate", () => {
    const page = renderToStaticMarkup(<OpeningScreen app="editor" title="Opening collection" />);
    expect(page).toContain("mdbase-opening-help");
    const panel = renderToStaticMarkup(<OpeningScreen app="editor" layout="panel" title="Opening collection" />);
    expect(panel).toMatch(/^<div class="mdbase-opening"/u);
    expect(panel).not.toContain("mdbase-opening-help");
  });

  it("says a status once when the error repeats it", () => {
    const markup = renderToStaticMarkup(<ConnectLayout app="reader" title="Open Reader" status="Not allowed" error="Not allowed" />);
    expect(markup.match(/Not allowed/g)).toHaveLength(1);
  });
});
