import assert from "node:assert/strict";
import test from "node:test";
import { editorRedirectTarget } from "./src/editor-redirect.ts";

const configured = "https://editor.example/connect?server=https%3A%2F%2Fconnect.example";

test("bridges only recognized account callback state into the editor", () => {
  const target = new URL(editorRedirectTarget(configured, {
    origin: "https://connect.example",
    pathname: "/account",
    search: "?linked=github&untrusted=value",
    hash: "#delete_token=act_abc-123&untrusted=value"
  }));

  assert.equal(target.origin, "https://editor.example");
  assert.equal(target.pathname, "/connect/account");
  assert.equal(target.searchParams.get("server"), "https://connect.example");
  assert.equal(target.searchParams.get("linked"), "github");
  assert.equal(target.searchParams.has("untrusted"), false);
  assert.equal(target.hash, "#delete_token=act_abc-123");
});

test("drops malformed account callback values", () => {
  const target = new URL(editorRedirectTarget(configured, {
    origin: "https://connect.example",
    pathname: "/account",
    search: "?linked=unknown",
    hash: "#delete_token=https://evil.example"
  }));

  assert.equal(target.pathname, "/connect/account");
  assert.equal(target.searchParams.has("linked"), false);
  assert.equal(target.hash, "");
});

test("does not reinterpret ordinary portal redirects", () => {
  assert.equal(editorRedirectTarget(configured, {
    origin: "https://connect.example",
    pathname: "/",
    search: "?linked=github",
    hash: "#delete_token=act_token"
  }), configured);
});
