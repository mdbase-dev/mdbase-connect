import assert from "node:assert/strict";
import test from "node:test";

import { resolveDevelopmentOrigins } from "./development-origins.mjs";

test("uses one 127.0.0.1 site for the default development stack", () => {
  assert.deepEqual(resolveDevelopmentOrigins({}, "8787"), {
    publicUrl: "http://127.0.0.1:8787",
    managementOrigins: ["http://127.0.0.1:5173"],
    editorOrigin: "http://127.0.0.1:5173"
  });
});

test("accepts a consistently configured localhost development stack", () => {
  assert.deepEqual(resolveDevelopmentOrigins({
    PUBLIC_URL: "http://localhost:8787",
    MDBASE_CONNECT_MANAGEMENT_ORIGINS: "http://localhost:5173"
  }), {
    publicUrl: "http://localhost:8787",
    managementOrigins: ["http://localhost:5173"],
    editorOrigin: "http://localhost:5173"
  });
});

test("normalizes a comma-separated origin allowlist", () => {
  assert.deepEqual(resolveDevelopmentOrigins({
    PUBLIC_URL: "http://127.0.0.1:8787",
    MDBASE_CONNECT_MANAGEMENT_ORIGINS: " http://127.0.0.1:5173/, "
  }).managementOrigins, ["http://127.0.0.1:5173"]);
});

test("rejects loopback host mismatches that would withhold the account cookie", () => {
  assert.throws(() => resolveDevelopmentOrigins({
    PUBLIC_URL: "http://127.0.0.1:8787",
    MDBASE_CONNECT_MANAGEMENT_ORIGINS: "http://localhost:5173"
  }), /mixing them causes a sign-in redirect loop/);
});
