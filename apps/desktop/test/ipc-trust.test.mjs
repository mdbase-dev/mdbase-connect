import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isTrustedSender } = require("../dist/main/ipc-trust.js");

const RENDERER = "file:///opt/mdbase/resources/app.asar/dist/renderer/index.html";

function windowWith(url) {
  const mainFrame = { url };
  const webContents = { mainFrame, destroyed: false, isDestroyed() { return this.destroyed; } };
  return { webContents, destroyed: false, isDestroyed() { return this.destroyed; } };
}

test("only the owning window's main frame on the packaged renderer page may use the API", () => {
  const owner = windowWith(RENDERER);
  const from = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });
  assert.equal(isTrustedSender(from(owner), owner, RENDERER), true);
  owner.webContents.mainFrame.url = `${RENDERER}#/access`;
  assert.equal(isTrustedSender(from(owner), owner, RENDERER), true, "in-page route");

  const other = windowWith(RENDERER);
  assert.equal(isTrustedSender(from(other), owner, RENDERER), false, "another window");
  assert.equal(isTrustedSender(from(owner, { url: RENDERER }), owner, RENDERER), false, "a subframe");
  assert.equal(isTrustedSender({ sender: owner.webContents, senderFrame: null }, owner, RENDERER), false, "no frame");
  const elsewhere = windowWith("file:///home/user/Downloads/page.html");
  assert.equal(isTrustedSender(from(elsewhere), elsewhere, RENDERER), false, "a different local file");
  assert.equal(isTrustedSender(from(owner), null, RENDERER), false, "no window yet");
  owner.webContents.destroyed = true;
  assert.equal(isTrustedSender(from(owner), owner, RENDERER), false, "destroyed window");
});
