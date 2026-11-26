import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_ENDPOINT_URL,
  MCP_SETUP_URL,
  appsByCollection,
  collectionAppUrl,
  collectionDiscoveryApps,
  homeApps,
  isMcpApp,
  letterMark,
  officialAppsAt
} from "./dist/home.js";

const official = [
  { id: "editor", name: "Editor", url: "https://editor.mdbase.dev", description: "Edit" },
  { id: "reader", name: "Reader", url: "https://reader.mdbase.dev", description: "Read" },
  { id: "journal", name: "Journal", url: "https://journal.mdbase.dev", description: "Journal" }
];
const notes = { id: "c-notes", name: "Notes" };

test("approved apps open from their HTTPS homepage, show only same-origin icons, and suggestions skip what is used or waiting", () => {
  const { yours, suggested } = homeApps([
    { id: "a1", name: "Editor", distribution: "web", homepage: "https://editor.mdbase.dev/", icon: null, collections: [notes] },
    { id: "a2", name: "Sketch", distribution: "portable", homepage: "https://sketch.example/", icon: "https://sketch.example/icon.png", collections: [] },
    { id: "a3", name: "Plain", distribution: "web", homepage: "http://plain.example/", icon: null, collections: [] },
    { id: "a4", name: "Other", distribution: "web", homepage: null, icon: null, collections: [] },
    { id: "a5", name: "Board", distribution: "web", homepage: "https://board.example/app", icon: "https://board.example/icon.svg", collections: [] },
    { id: "a6", name: "Elsewhere", distribution: "web", homepage: "https://elsewhere.example/", icon: "https://cdn.example/icon.png", collections: [] }
  ], official, ["journal"]);
  assert.deepEqual(yours.map(app => [app.name, app.url, app.description, app.official, app.icon]), [
    ["Editor", "https://editor.mdbase.dev/", "Edit", "editor", null],
    ["Sketch", null, undefined, undefined, null],
    ["Plain", null, undefined, undefined, null],
    ["Other", null, undefined, undefined, null],
    ["Board", "https://board.example/app", undefined, undefined, "https://board.example/icon.svg"],
    ["Elsewhere", "https://elsewhere.example/", undefined, undefined, null]
  ]);
  assert.deepEqual(suggested.map(app => [app.key, app.official, app.icon]), [["reader", "reader", null]]);
});

test("a custom server suggests nothing", () => {
  assert.deepEqual(homeApps([], [], []).suggested, []);
});

test("collections list the apps that use them", () => {
  const byCollection = appsByCollection([
    { id: "a", name: "Editor", distribution: "web", homepage: null, icon: null, collections: [notes] },
    { id: "b", name: "TaskNotes", distribution: "web", homepage: null, icon: null, collections: [notes, { id: "c-tasks", name: "Tasks" }] }
  ]);
  assert.deepEqual(byCollection.get("c-notes"), ["Editor", "TaskNotes"]);
  assert.deepEqual(byCollection.get("c-tasks"), ["TaskNotes"]);
});

test("letter marks are stable", () => {
  assert.deepEqual(letterMark("tasknotes"), letterMark("tasknotes"));
  assert.equal(letterMark(" écrit").letter, "É");
  assert.ok(letterMark("Journal").tone >= 0 && letterMark("Journal").tone < 5);
});

test("only a managed environment has official apps", () => {
  assert.deepEqual(officialAppsAt(undefined), []);
  const apps = officialAppsAt({
    editorOrigin: "https://editor.lab.example", readerOrigin: "https://reader.lab.example", writerOrigin: "https://writer.lab.example",
    journalOrigin: "https://journal.lab.example", tasknotesOrigin: "https://tasks.lab.example"
  });
  assert.deepEqual(apps.map(app => [app.id, app.url]), [
    ["editor", "https://editor.lab.example"], ["reader", "https://reader.lab.example"], ["writer", "https://writer.lab.example"],
    ["journal", "https://journal.lab.example"], ["tasknotes", "https://tasks.lab.example"]
  ]);
});

test("collectionAppUrl appends the collection query parameter cleanly", () => {
  assert.equal(collectionAppUrl("https://reader.mdbase.dev", "c-notes"), "https://reader.mdbase.dev/?collection=c-notes");
  assert.equal(collectionAppUrl("https://writer.mdbase.dev/app?view=drafts", "c-notes"), "https://writer.mdbase.dev/app?view=drafts&collection=c-notes");
  assert.equal(collectionAppUrl("https://editor.mdbase.dev/?collection=old", "c-new"), "https://editor.mdbase.dev/?collection=c-new");
  assert.equal(MCP_ENDPOINT_URL, "https://mcp.mdbase.dev/mcp");
  assert.equal(MCP_SETUP_URL, "https://mdbase.dev/apps/mcp/");
});

test("isMcpApp identifies MCP by origin or name", () => {
  assert.equal(isMcpApp({ origin: "https://mcp.mdbase.dev", name: "Claude" }), true);
  assert.equal(isMcpApp({ origin: "https://mcp-lab.mdbase.dev", name: "Codex" }), true);
  assert.equal(isMcpApp({ name: "mdbase MCP" }), true);
  assert.equal(isMcpApp({ name: "MCP" }), true);
  assert.equal(isMcpApp({ origin: "https://reader.mdbase.dev", name: "Reader" }), false);
});

test("collectionDiscoveryApps filters out approved official apps and MCP and scopes links to the collection", () => {
  const origins = {
    editorOrigin: "https://editor.mdbase.dev",
    readerOrigin: "https://reader.mdbase.dev",
    writerOrigin: "https://writer.mdbase.dev",
    journalOrigin: "https://journal.mdbase.dev",
    tasknotesOrigin: "https://app.tasknotes.dev"
  };
  assert.deepEqual(collectionDiscoveryApps(undefined, "c-notes", []), { apps: [], showMcp: false });

  const filtered = collectionDiscoveryApps(origins, "c-notes", [
    { origin: "https://reader.mdbase.dev", name: "mdbase Reader" },
    { origin: "capacitor://localhost", name: "tasknotes" }
  ]);
  assert.deepEqual(filtered.apps.map(app => [app.key, app.url]), [
    ["editor", "https://editor.mdbase.dev/?collection=c-notes"],
    ["writer", "https://writer.mdbase.dev/?collection=c-notes"],
    ["journal", "https://journal.mdbase.dev/?collection=c-notes"]
  ]);
  assert.equal(filtered.showMcp, true);

  const afterMcp = collectionDiscoveryApps(origins, "c-notes", [{ origin: "https://mcp.mdbase.dev", name: "Claude" }]);
  assert.equal(afterMcp.apps.length, 5);
  assert.equal(afterMcp.showMcp, false);
});
