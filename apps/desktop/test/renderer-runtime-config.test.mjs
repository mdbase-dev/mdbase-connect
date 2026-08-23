import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultConnectServerUrl,
  PRODUCTION_CONNECT_ORIGIN
} from "../src/renderer/runtime-config.ts";

test("uses an isolated desktop Connect origin instead of the production fallback", () => {
  assert.equal(
    defaultConnectServerUrl(" https://mdbase-connect-lab.onrender.com/ "),
    "https://mdbase-connect-lab.onrender.com"
  );
  assert.equal(defaultConnectServerUrl(undefined), PRODUCTION_CONNECT_ORIGIN);
});

test("rejects unsafe or non-origin Connect defaults", () => {
  for (const value of [
    "https://user:secret@connect.example",
    "https://connect.example/path",
    "http://connect.example"
  ]) {
    assert.throws(
      () => defaultConnectServerUrl(value),
      /credential-free HTTPS origin|valid origin/u
    );
  }
  assert.equal(
    defaultConnectServerUrl("http://127.0.0.1:8787"),
    "http://127.0.0.1:8787"
  );
});
