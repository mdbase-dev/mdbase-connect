import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { routeForDeepLink, shouldRegisterDeepLinks } = require("../dist/main/deep-link.js");

test("isolated profiles do not replace the operating system deep-link owner", () => {
  assert.equal(shouldRegisterDeepLinks({ MDBASE_CONNECT_REGISTER_DEEP_LINKS: "0" }), false);
  assert.equal(shouldRegisterDeepLinks({}), true);
});

test("authorization links preserve the exact request route", () => {
  assert.equal(
    routeForDeepLink("mdbase-connect://authorize?request_id=request%2Fwith%20spaces"),
    "access:request/with spaces"
  );
  assert.equal(routeForDeepLink("mdbase-connect://authorize"), "access");
});

test("pairing confirmation links open the paired route", () => {
  assert.equal(routeForDeepLink("mdbase-connect://paired"), "paired");
});

test("malformed and unrelated links are ignored", () => {
  assert.equal(routeForDeepLink(undefined), null);
  assert.equal(routeForDeepLink("not a url"), null);
  assert.equal(routeForDeepLink("https://connect.mdbase.dev/authorize"), null);
  assert.equal(routeForDeepLink("mdbase-connect://unknown"), null);
  // The legacy folder-sync link is no longer produced or handled.
  assert.equal(routeForDeepLink("mdbase-connect://mirror?collection=collection-1"), null);
});
