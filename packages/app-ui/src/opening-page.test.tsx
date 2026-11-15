// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { MdbaseAppId } from "./apps.js";
import { mdbaseOpeningPage, OPENING_MARKER, openingPageMarkup, openingPageScript, openingPageStyles } from "./opening-page.js";
import { OpeningScreen } from "./screens.js";

const themeColor = { light: "#fcfcfd", dark: "#1b1d23" };
const root = { path: "/index.html" };
const index = `<!doctype html><html><head><meta charset="UTF-8" /><title>mdbase editor</title><link rel="stylesheet" href="/app.css"></head><body><div id="root">${OPENING_MARKER}</div></body></html>`;

describe("opening page", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  it.each<[MdbaseAppId, string | undefined]>([
    ["editor", "Reading notes and files"],
    ["reader", undefined],
    ["writer", "Checking <the> collection"]
  ])("paints the markup %s's OpeningScreen renders", (app, detail) => {
    const page = openingPageMarkup({ app, title: "Opening your collection", detail })
      .replace(' data-opening-page=""', "")
      .replace(/<noscript>.*<\/noscript>/u, "");
    expect(page).toBe(renderToStaticMarkup(<OpeningScreen app={app} title="Opening your collection" detail={detail} />));
  });

  it("puts its styles and script right after the charset, ahead of the app's own CSS", () => {
    const html = mdbaseOpeningPage({ app: "editor", title: "Opening collection", themeColor }).transformIndexHtml.handler(index, root);
    const order = ['<meta charset="UTF-8" />', '<meta name="theme-color" content="#fcfcfd" />', "<style>", "<script>", '<link rel="stylesheet"'].map((part) => html.indexOf(part));
    expect(order.every((at, position) => at >= 0 && (position === 0 || at > order[position - 1]!))).toBe(true);
    expect(html).not.toContain(OPENING_MARKER);
    expect(html).toContain('<div id="root"><main class="mdbase-opening" data-app="editor"');
  });

  it("refuses an index.html it would have to guess about", () => {
    const plugin = mdbaseOpeningPage({ app: "reader", title: "Opening your library", themeColor });
    expect(() => plugin.transformIndexHtml.handler(index.replace(OPENING_MARKER, ""), root)).toThrow(OPENING_MARKER);
    expect(() => plugin.transformIndexHtml.handler(index.replace("<title>", '<meta name="theme-color" content="#fff" /><title>'), root)).toThrow("theme-color");
    expect(() => plugin.transformIndexHtml.handler(index.replace('<meta charset="UTF-8" />', ""), root)).toThrow("charset");
    // Other pages the app serves, such as test fixtures, are not the app's opening.
    const fixture = "<!doctype html><html><head></head><body></body></html>";
    expect(plugin.transformIndexHtml.handler(fixture, { path: "/test-fixtures/probe.html" })).toBe(fixture);
  });

  it("inlines only what draws the screen", () => {
    const styles = openingPageStyles();
    expect(styles).not.toMatch(/\/\*|@import/u);
    for (const rule of ["--color-canvas", "@keyframes mdbase-scan", ".mdbase-opening-help"]) expect(styles).toContain(rule);
  });

  it("applies the saved theme before paint", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#fcfcfd">';
    localStorage.setItem("mdbase:theme", "dark");
    window.eval(openingPageScript({ app: "editor", themeColor }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe("#1b1d23");
    // No opening page here, so the first error detaches this script's listeners.
    window.dispatchEvent(new ErrorEvent("error", { message: "unrelated" }));
  });

  it("says in place when the app fails to start, and stops listening once the app has taken over", () => {
    document.body.innerHTML = `<div id="root">${openingPageMarkup({ app: "reader", title: "Opening your library" })}</div>`;
    window.eval(openingPageScript({ app: "reader", themeColor }));
    const page = document.querySelector<HTMLElement>("[data-opening-page]")!;

    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught Error: Failed to fetch dynamically imported module" }));
    expect(page.dataset.loadingState).toBe("failed");
    expect(page.getAttribute("aria-busy")).toBe("false");
    const alert = page.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("mdbase reader could not start: Failed to fetch dynamically imported module Reload");
    expect(alert.querySelector("a")?.getAttribute("href")).toBe("");

    window.dispatchEvent(new ErrorEvent("error", { message: "A second failure" }));
    expect(alert.textContent).not.toContain("second");

    // The app replaces the page with its own screen, which the script must never touch.
    document.body.innerHTML = renderToStaticMarkup(<OpeningScreen app="reader" title="Opening your library" />);
    window.dispatchEvent(new ErrorEvent("error", { message: "Image failed" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Image failed" }));
    expect(document.querySelector(".mdbase-opening")?.getAttribute("data-loading-state")).toBe("opening");
  });
});
