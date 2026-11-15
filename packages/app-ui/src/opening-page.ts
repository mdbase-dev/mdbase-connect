/// <reference types="node" />
/**
 * The opening screen as static HTML, so an app paints it before any script runs.
 *
 * `mdbaseOpeningPage` is a Vite plugin. It replaces `<!--mdbase-opening-->` in index.html
 * with the same markup `OpeningScreen` renders, and inlines the stylesheets that draw it
 * (tokens.css, brand.css, screens.css) and one small script. The page scans without
 * JavaScript, reveals a reload hint after eight seconds with CSS alone, says when
 * JavaScript is off, and, through the script, says in place when the app fails to start.
 *
 * Node only: import it from vite.config, never from app code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MdbaseAppId } from "./apps.js";

export interface OpeningPageOptions {
  readonly app: MdbaseAppId;
  /**
   * What the app is opening, as its `OpeningScreen` title. The page paints before any
   * catalogue loads, so this is English; the app's own screen takes over in the reader's language.
   */
  readonly title: string;
  readonly detail?: string | undefined;
  /** The browser chrome colour in each theme. The plugin writes the theme-color meta. */
  readonly themeColor: { readonly light: string; readonly dark: string };
}

/** Where index.html wants the opening screen, usually as the React root's only child. */
export const OPENING_MARKER = "<!--mdbase-opening-->";

const escape = (text: string): string => text
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const rect = (index: number, kind: "ink" | "accent", x: number, y: number, width: number): string =>
  `<rect class="mdbase-mark-segment mdbase-mark-segment-${index} mdbase-mark-${kind}" x="${x}" y="${y}" width="${width}" height="10"></rect>`;

/** `MdbaseMark` with `motion="scan"`, as React renders it. */
function scanningMark(app: MdbaseAppId): string {
  const owner = app === "editor" ? "" : ` mdbase-app-mark is-${app}`;
  return `<svg class="mdbase-mark${owner} mdbase-motion-scan" viewBox="18 18 84 84" aria-hidden="true" focusable="false">`
    + `<g class="mdbase-mark-lines">`
    + `<g class="mdbase-mark-fence mdbase-mark-fence-top">${rect(1, "ink", 22, 22, 20)}${rect(2, "ink", 50, 22, 20)}${rect(3, "ink", 78, 22, 20)}</g>`
    + `<g class="mdbase-mark-row mdbase-mark-row-top">${rect(4, "ink", 22, 44, 12)}${rect(5, "accent", 42, 44, 56)}</g>`
    + `<g class="mdbase-mark-row mdbase-mark-row-bottom">${rect(6, "ink", 22, 66, 28)}${rect(7, "ink", 58, 66, 40)}</g>`
    + `<g class="mdbase-mark-fence mdbase-mark-fence-bottom">${rect(8, "ink", 22, 88, 20)}${rect(9, "ink", 50, 88, 20)}${rect(10, "ink", 78, 88, 20)}</g>`
    + `</g></svg>`;
}

/**
 * `OpeningScreen`'s page markup, plus what only a static page needs: a marker the boot
 * script looks for, and a notice for a browser without JavaScript.
 */
export function openingPageMarkup({ app, title, detail }: Pick<OpeningPageOptions, "app" | "title" | "detail">): string {
  return `<main class="mdbase-opening" data-app="${app}" data-loading-state="opening" aria-label="${escape(title)}" aria-busy="true" data-opening-page="">`
    + `<div class="mdbase-opening-message">`
    + `<span class="mdbase-opening-mark">${scanningMark(app)}</span>`
    + `<span class="mdbase-opening-name">mdbase <strong>${app}</strong></span>`
    + `<div class="mdbase-opening-text">`
    + `<div role="status"><p>${escape(title)}</p>${detail ? `<small>${escape(detail)}</small>` : ""}</div>`
    + `<noscript><p class="mdbase-opening-nojs">mdbase ${app} needs JavaScript to open.</p></noscript>`
    + `</div>`
    + `<p class="mdbase-opening-help">Still opening? Check your connection. <a href="">Reload</a></p>`
    + `</div></main>`;
}

/**
 * Applies the saved theme before first paint, and, while the static page is still showing,
 * turns a failed bundle or startup error into the screen's failure state. Once the app has
 * replaced the page, it stops listening.
 */
export function openingPageScript({ app, themeColor }: Pick<OpeningPageOptions, "app" | "themeColor">): string {
  return `(() => {
  try {
    const theme = localStorage.getItem("mdbase:theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelector('meta[name="theme-color"]').content = dark ? ${JSON.stringify(themeColor.dark)} : ${JSON.stringify(themeColor.light)};
  } catch {}
  const failed = (event) => {
    const page = document.querySelector("[data-opening-page]");
    if (!page) {
      removeEventListener("error", failed, true);
      removeEventListener("unhandledrejection", failed);
      return;
    }
    if (page.dataset.loadingState === "failed") return;
    const reason = String(event.reason?.message || event.message || "the application files could not load.")
      .replace(/^Uncaught (?:Error:\\s*)?/, "");
    const alert = document.createElement("p");
    alert.setAttribute("role", "alert");
    const reload = document.createElement("a");
    reload.href = "";
    reload.textContent = "Reload";
    alert.append(${JSON.stringify(`mdbase ${app} could not start: `)} + reason + " ", reload);
    page.querySelector(".mdbase-opening-text").append(alert);
    page.dataset.loadingState = "failed";
    page.setAttribute("aria-busy", "false");
  };
  addEventListener("error", failed, true);
  addEventListener("unhandledrejection", failed);
})();`;
}

/** The stylesheets the opening screen is drawn with, without comments. */
export function openingPageStyles(): string {
  return ["tokens", "brand", "screens"]
    // src/ in tests, dist/ when published: css/ is beside both.
    .map((name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "css", `${name}.css`), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\n\s*\n/gu, "\n");
}

/** Writes the opening page into the app's root index.html, leaving any other page alone. */
export function mdbaseOpeningPage(options: OpeningPageOptions): {
  name: string;
  transformIndexHtml: { order: "post"; handler: (html: string, context: { readonly path: string }) => string };
} {
  const styles = openingPageStyles();
  return {
    name: "mdbase-opening-page",
    transformIndexHtml: {
      // After Vite's own tags are in, so the inline styles still come first and app CSS overrides them.
      order: "post",
      handler(html, { path }) {
        if (path !== "/index.html") return html;
        if (!html.includes(OPENING_MARKER)) throw new Error(`index.html has no ${OPENING_MARKER} for the opening screen.`);
        if (/<meta\s+name="theme-color"/u.test(html)) throw new Error("index.html sets theme-color; mdbaseOpeningPage writes it from its themeColor option.");
        const charset = /<meta\s+charset=[^>]*>/iu.exec(html);
        if (!charset) throw new Error("index.html needs <meta charset> before the opening page's inline styles.");
        const head = `\n    <meta name="theme-color" content="${escape(options.themeColor.light)}" />`
          + `\n    <style>${styles}</style>`
          + `\n    <script>${openingPageScript(options)}</script>`;
        const at = charset.index + charset[0].length;
        return (html.slice(0, at) + head + html.slice(at)).replace(OPENING_MARKER, () => openingPageMarkup(options));
      },
    },
  };
}
