import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { i18n } from "@mdbase-dev/ui/i18n";
import { confirmationArgument, describeConfirmation, parseConfirmation } from "../src/main/confirmation.ts";

// What the daemon passes (runtime/crates/daemon/src/confirm.rs, Prompt::app_argument).
const approveApp = {
  v: 1, kind: "approve_app", app: "Fixture app", collection: "Notes",
  capabilities: ["collection.read", "records.edit", "custom.thing"], folders: null, key: "ABCD-EFGH",
  title: "Approve app access", message: "English approve message"
};

test("only the daemon's switch starts a confirmation, and a malformed prompt is refused", () => {
  assert.equal(confirmationArgument(["mdbase-connect", "mdbase-connect://open"]), null);
  const argument = `--mdbase-confirm=${JSON.stringify(approveApp)}`;
  assert.deepEqual(parseConfirmation(confirmationArgument(["mdbase-connect", argument])), approveApp);
  for (const bad of ["", "null", "[]", "{\"v\":1}", "{\"v\":1,\"kind\":\"x\",\"title\":\"t\"}"]) {
    assert.throws(() => parseConfirmation(bad), bad);
  }
});

test("each prompt names the action, the app and the collection, with Deny and Allow", () => {
  const app = describeConfirmation(approveApp);
  assert.equal(app.title, "Approve app access");
  assert.equal(app.message, "Allow Fixture app to use Notes through this computer?");
  assert.match(app.detail, /^Access: read records and files, edit records and files, custom\.thing$/m);
  assert.match(app.detail, /^Folders: whole collection$/m);
  assert.match(app.detail, /^App key: ABCD-EFGH$/m);
  assert.match(describeConfirmation({ ...approveApp, folders: ["a", "b/c"] }).detail, /^Folders: a, b\/c$/m);
  assert.deepEqual([app.deny, app.allow], ["Deny", "Allow"]);
  const mode = (isPrivate) => describeConfirmation({ v: 1, kind: "collection_mode", collection: "Notes", private: isPrivate, title: "", message: "" });
  assert.equal(mode(false).message, "Turn on Cloud copy for Notes?");
  assert.equal(mode(true).message, "Make Notes private?");
  assert.equal(describeConfirmation({ v: 1, kind: "link_obsidian", collection: "Notes", title: "", message: "" }).message,
    "Let Obsidian on this computer use Notes?");
  assert.equal(describeConfirmation({ v: 1, kind: "disable_approval", title: "", message: "" }).title, "Turn off approval");
});

test("a kind or version this app does not know shows the daemon's English wording", () => {
  for (const request of [{ ...approveApp, kind: "approve_device" }, { ...approveApp, v: 2 }]) {
    const text = describeConfirmation(request);
    assert.deepEqual([text.title, text.message, text.detail], ["Approve app access", "English approve message", ""]);
  }
});

test("the dialog follows the language chosen in the app", async () => {
  const german = JSON.parse(await readFile(new URL("../src/locales/de/messages.json", import.meta.url), "utf8"));
  i18n.loadAndActivate({ locale: "de", messages: german.messages });
  try {
    const text = describeConfirmation({ v: 1, kind: "collection_mode", collection: "Notizen", private: false, title: "", message: "" });
    assert.equal(text.message, "Cloud-Kopie für Notizen aktivieren?");
    assert.deepEqual([text.deny, text.allow], ["Ablehnen", "Erlauben"]);
  } finally {
    i18n.activate("en");
  }
});
