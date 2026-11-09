import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { appModeCommand, desktopEntryCommand, launchUrl, openApp } = require("../dist/main/app-launcher.js");

const url = "https://app.tasknotes.dev/";

test("apps open only from credential-free HTTPS addresses", () => {
  assert.equal(launchUrl("https://journal.mdbase.dev", false), "https://journal.mdbase.dev/");
  assert.throws(() => launchUrl("http://journal.mdbase.dev/", false), /HTTPS/);
  assert.throws(() => launchUrl("https://user:secret@journal.mdbase.dev/", false), /HTTPS/);
  assert.throws(() => launchUrl("file:///etc/passwd", false), /HTTPS/);
  assert.throws(() => launchUrl("not a url", false), /Invalid app address/);
  assert.throws(() => launchUrl("http://127.0.0.1:5173/", false), /HTTPS/);
  assert.equal(launchUrl("http://127.0.0.1:5173/", true), "http://127.0.0.1:5173/");
});

test("Chromium-based default browsers get an app-mode window", () => {
  assert.deepEqual(
    appModeCommand({ name: "Google Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }, "win32", url),
    { command: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: [`--app=${url}`] }
  );
  assert.deepEqual(
    appModeCommand({ name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app" }, "darwin", url),
    { command: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", args: [`--app=${url}`] }
  );
  assert.deepEqual(
    appModeCommand({ name: "com.brave.Browser.desktop", path: "/usr/bin/flatpak", args: ["run", "com.brave.Browser"] }, "linux", url),
    { command: "/usr/bin/flatpak", args: ["run", "com.brave.Browser", `--app=${url}`] }
  );
});

test("other default browsers keep an ordinary tab", () => {
  assert.equal(appModeCommand({ name: "Firefox", path: "/Applications/Firefox.app" }, "darwin", url), null);
  assert.equal(appModeCommand({ name: "Safari", path: "/Applications/Safari.app" }, "darwin", url), null);
  assert.equal(appModeCommand({ name: "firefox.desktop", path: "/usr/lib/firefox/firefox" }, "linux", url), null);
});

test("desktop entries yield their command without field codes", () => {
  assert.deepEqual(
    desktopEntryCommand("[Desktop Entry]\nName=Google Chrome\nExec=/usr/bin/google-chrome-stable %U\n[Desktop Action new-window]\nExec=/usr/bin/google-chrome-stable --new-window\n"),
    { path: "/usr/bin/google-chrome-stable", args: [] }
  );
  assert.deepEqual(
    desktopEntryCommand("[Desktop Entry]\nExec=/usr/bin/flatpak run --branch=stable --command=chromium org.chromium.Chromium @@u %U @@\n"),
    { path: "/usr/bin/flatpak", args: ["run", "--branch=stable", "--command=chromium", "org.chromium.Chromium"] }
  );
  assert.equal(desktopEntryCommand("[Desktop Action new]\nExec=/usr/bin/x\n"), null);
});

test("opening falls back to the default browser when app mode is unavailable or fails", async () => {
  const opened = [];
  const started = [];
  const deps = (browser, start) => ({
    platform: "linux",
    defaultBrowser: async () => browser,
    start: async (command) => { started.push(command); await start?.(); },
    openExternal: async (href) => { opened.push(href); }
  });

  await openApp(url, deps({ name: "google-chrome.desktop", path: "/usr/bin/google-chrome" }));
  assert.deepEqual(started, [{ command: "/usr/bin/google-chrome", args: [`--app=${url}`] }]);
  assert.deepEqual(opened, []);

  await openApp(url, deps({ name: "firefox.desktop", path: "/usr/bin/firefox" }));
  await openApp(url, deps(null));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await openApp(url, deps({ name: "chromium.desktop", path: "/usr/bin/chromium" }, () => { throw new Error("ENOENT"); }));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(opened, [url, url, url]);
});
