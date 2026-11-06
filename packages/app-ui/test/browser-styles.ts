import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

export async function openSharedStyleFixture(page: Page) {
  const modules = new Map([
    ["@codemirror/view", new URL("../node_modules/@codemirror/view/dist/index.js", import.meta.url)],
    ["@codemirror/state", new URL("../node_modules/@codemirror/state/dist/index.js", import.meta.url)],
    ["@codemirror/lint", new URL("../../../apps/editor/node_modules/@codemirror/lint/dist/index.js", import.meta.url)],
    ["@marijn/find-cluster-break", new URL("../node_modules/@marijn/find-cluster-break/src/index.js", import.meta.url)],
    ["style-mod", new URL("../node_modules/style-mod/src/style-mod.js", import.meta.url)],
    ["w3c-keyname", new URL("../node_modules/w3c-keyname/index.js", import.meta.url)],
    ["crelt", new URL("../../../apps/editor/node_modules/crelt/index.js", import.meta.url)],
    ["theme", new URL("../dist/codemirror.js", import.meta.url)]
  ]);
  const css = await Promise.all(["tokens", "controls", "collections"].map(name => readFile(new URL(`../css/${name}.css`, import.meta.url), "utf8")));
  css.push(await readFile(new URL("../../ui/styles.css", import.meta.url), "utf8"));
  await page.route("**/__shared-style/**", async route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice("/__shared-style/".length));
    const path = modules.get(name);
    if (path) return route.fulfill({ contentType: "text/javascript", body: await readFile(path, "utf8") });
    if (name !== "index.html") return route.abort();
    const imports = Object.fromEntries([...modules.keys()].map(name => [name, `/__shared-style/${encodeURIComponent(name)}`]));
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Shared UI style fixture</title>
      <style>${css.join("\n").replace(/^@import.*$/gm, "")} body { margin: 24px; color: var(--color-text); background: var(--color-canvas); } section { display: grid; gap: 12px; margin-bottom: 24px; }</style>
      <script type="importmap">${JSON.stringify({ imports })}</script>
      <section class="mdbase-collections">${["warning", "error", "info"].map(tone => `<div class="mdbase-collections-notice" data-tone="${tone}"><p>${tone} notice</p><button class="mdbase-collections-button">Review ${tone}</button></div>`).join("")}</section>
      <button class="view-tab active">Selected navigation</button><div id="editor"></div><script type="module">
        import { EditorView, keymap } from "@codemirror/view";
        import { linter, lintKeymap } from "@codemirror/lint";
        import { mdbasePopupTheme } from "theme";
        new EditorView({ parent: document.querySelector("#editor"), extensions: [mdbasePopupTheme, keymap.of(lintKeymap),
          EditorView.contentAttributes.of({ "aria-label": "Diagnostic input" }),
          linter(view => { const severity = view.state.doc.toString(); return ["error", "warning", "info", "hint"].includes(severity)
            ? [{ from: 0, to: severity.length, severity, message: severity + " diagnostic" }] : []; }, { delay: 0 })] });
      </script></html>` });
  });
  await page.goto("/__shared-style/index.html");
}
