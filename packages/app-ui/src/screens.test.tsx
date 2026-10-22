import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConnectLayout, OpeningScreen } from "./screens.js";

describe("screens", () => {
  it("opens with the app's wordmark and turns a failure into a retry", () => {
    expect(renderToStaticMarkup(<OpeningScreen app="reader" title="Opening collection" detail="Reading its sources" />))
      .toContain('aria-busy="true"');
    const failed = renderToStaticMarkup(<OpeningScreen app="writer" title="Opening" error="Connect is unavailable" onRetry={() => {}} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Try again");
  });

  it("renders the launch screen with a large mark that scans once it has landed", () => {
    const markup = renderToStaticMarkup(<OpeningScreen app="editor" title="Opening collection" detail="Reading its notes" entrance="flock" />);
    expect(markup).toContain("mdbase-opening-launch-mark");
    expect(markup).toContain('data-entrance="landed"');
    expect(markup).toContain("mdbase-motion-scan");
    expect(markup).toContain("Reading its notes");
    expect(markup).not.toContain("mdbase-opening-flock");
  });

  it("says a status once when the error repeats it", () => {
    const markup = renderToStaticMarkup(<ConnectLayout app="reader" title="Open Reader" status="Not allowed" error="Not allowed" />);
    expect(markup.match(/Not allowed/g)).toHaveLength(1);
  });
});
