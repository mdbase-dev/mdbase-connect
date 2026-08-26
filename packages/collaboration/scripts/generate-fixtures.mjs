import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = resolve(here, "../../../test/fixtures/collaboration-v1");
await mkdir(fixtureDir, { recursive: true });

const initialBody = "# Shared 👋\n\nAlpha e\u0301 and café\n";
const initial = new Y.Doc({ guid: "mdbase-collaboration-v1-initial" });
initial.clientID = 1_001;
const initialText = initial.getText("body");
initialText.insert(0, initialBody);
const initialUpdate = Y.encodeStateAsUpdate(initial);
const oldStateVector = Y.encodeStateVector(initial);

const browser = new Y.Doc({ guid: "mdbase-collaboration-v1-browser" });
browser.clientID = 2_002;
browser.getText("body");
Y.applyUpdate(browser, initialUpdate);
const browserBefore = Y.encodeStateVector(browser);
const alphaAt = browser.getText("body").toString().indexOf("Alpha");
browser.transact(() => {
  browser.getText("body").delete(alphaAt, "Alpha".length);
  browser.getText("body").insert(alphaAt, "Beta from browser");
  browser.getText("body").insert(browser.getText("body").length, "Offline 👩🏽‍💻\n");
}, "browser-offline");
const offlineUpdate = Y.encodeStateAsUpdate(browser, browserBefore);

await writeFile(resolve(fixtureDir, "initial-body.txt"), initialBody);
await writeFile(resolve(fixtureDir, "yjs-initial-update-v1.bin"), initialUpdate);
await writeFile(resolve(fixtureDir, "yjs-offline-update-v1.bin"), offlineUpdate);
await writeFile(resolve(fixtureDir, "yjs-old-state-vector-v1.bin"), oldStateVector);

if (process.argv.includes("--finalize")) {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".bin")).sort();
  const files = {};
  for (const name of names) {
    const bytes = await readFile(resolve(fixtureDir, name));
    files[name] = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }
  await writeFile(resolve(fixtureDir, "manifest.json"), `${JSON.stringify({
    contract_version: 1,
    profile: "markdown-body-yjs-v13",
    yjs_version: "13.6.32",
    yrs_version: "0.26.0",
    root: "body",
    offset_encoding: "utf16",
    body_encoding: "utf8",
    line_endings: "lf-only",
    files
  }, null, 2)}\n`);
}
