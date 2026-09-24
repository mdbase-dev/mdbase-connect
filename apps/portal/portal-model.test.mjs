import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePortalBootstrapSecrets,
  message,
  returnTarget,
  signInUrl
} from "./src/portal-model.ts";

test("captures one-time auth fragments before rendering and removes them from history", () => {
  const replacements = [];
  const secrets = capturePortalBootstrapSecrets(
    {
      hash: "#invitation=%20invite-secret%20&verification=verify-secret&reset=reset-secret",
      pathname: "/signup",
      search: "?return_to=%2Fauthorize%2Frequest"
    },
    {
      state: { preserved: true },
      replaceState(state, title, url) {
        replacements.push({ state, title, url });
      }
    }
  );

  assert.deepEqual(secrets, {
    invitationToken: "invite-secret",
    verificationToken: "verify-secret",
    resetToken: "reset-secret"
  });
  assert.deepEqual(replacements, [{
    state: { preserved: true },
    title: "",
    url: "/signup?return_to=%2Fauthorize%2Frequest"
  }]);
  assert.equal(Object.isFrozen(secrets), true);
});

test("does not rewrite unrelated fragments", () => {
  let replaced = false;
  const secrets = capturePortalBootstrapSecrets(
    { hash: "#section", pathname: "/login", search: "" },
    { state: null, replaceState() { replaced = true; } }
  );

  assert.deepEqual(secrets, {
    invitationToken: "",
    verificationToken: "",
    resetToken: ""
  });
  assert.equal(replaced, false);
});

test("preserves a same-origin signup return through sign in", () => {
  const currentLocation = {
    origin: "https://connect.example",
    search: "?return_to=%2Fauthorize%2Frequest%3Fsource%3Dsignup%23resume"
  };

  assert.equal(
    returnTarget(currentLocation),
    "https://connect.example/authorize/request?source=signup#resume"
  );
  const login = new URL(signInUrl(currentLocation), currentLocation.origin);
  assert.equal(login.pathname, "/login");
  assert.equal(
    login.searchParams.get("return_to"),
    "https://connect.example/authorize/request?source=signup#resume"
  );
});

test("does not preserve an invalid or cross-origin signup return", () => {
  for (const requested of [
    "https://evil.example/authorize/request",
    "http://[invalid"
  ]) {
    const currentLocation = {
      origin: "https://connect.example",
      search: `?return_to=${encodeURIComponent(requested)}`
    };
    assert.equal(returnTarget(currentLocation), "/");
    assert.equal(signInUrl(currentLocation), "/login");
  }
});

test("renders the first collection setup diagnostic with its path", () => {
  const error = Object.assign(
    new Error("Collection setup was rejected."),
    { details: { diagnostics: [{
        code: "schema_required",
        severity: "error",
        path: "broken.md",
        message: "Required property 'title' is missing."
      }] } }
  );

  assert.equal(
    message(error),
    "Required property 'title' is missing. (broken.md)"
  );
});
