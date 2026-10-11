import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { checkApprovalUrl } = require("../dist/main/approval-url.js");

test("sign-in pages open only on the build environment's control plane, as issued", () => {
  const prod = { environment: "production", allowLoopback: false };
  const issued = "https://connect.mdbase.dev/pair?code=ABCD-1234&request=r1";
  assert.equal(checkApprovalUrl(issued, prod), issued, "query is kept");
  assert.equal(checkApprovalUrl("https://connect-lab.mdbase.dev/pair?code=x", { environment: "lab", allowLoopback: false }), "https://connect-lab.mdbase.dev/pair?code=x");
  for (const refused of [
    "https://connect-lab.mdbase.dev/pair",          // another environment
    "https://connect.mdbase.dev.evil.example/pair",
    "http://connect.mdbase.dev/pair",
    "https://connect.mdbase.dev:8443/pair",
    "https://user:secret@connect.mdbase.dev/pair",  // userinfo in the original URI
    "https://user@connect.mdbase.dev/pair",
    "http://127.0.0.1:4000/pair",                   // loopback outside isolated development
    "not a url", ""
  ]) assert.throws(() => checkApprovalUrl(refused, prod), refused);
  assert.throws(() => checkApprovalUrl("https://connect.mdbase.dev/pair", { environment: "staging", allowLoopback: false }));
  const dev = { environment: "production", allowLoopback: true };
  assert.equal(checkApprovalUrl("http://127.0.0.1:4000/pair?code=x", dev), "http://127.0.0.1:4000/pair?code=x");
  assert.throws(() => checkApprovalUrl("http://u:p@localhost:4000/pair", dev));
  assert.throws(() => checkApprovalUrl("http://example.test/pair", dev));
});
