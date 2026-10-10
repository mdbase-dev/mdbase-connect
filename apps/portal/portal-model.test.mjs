import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePortalBootstrapSecrets,
  message,
  installationAccountLabel,
  returnTarget,
  signInUrl
} from "./src/portal-model.ts";

test("installation account label uses canonical identity, freezes confirmation and never invents email", () => {
  assert.equal(installationAccountLabel({signed_in_account_email:"owner@example.test",signed_in_account_provider:"github",signed_in_account_login:"login"}),"owner@example.test");
  assert.equal(installationAccountLabel({signed_in_account_email:null,signed_in_account_provider:"github",signed_in_account_login:"login"}),"GitHub account @login");
  assert.equal(installationAccountLabel({account_selection_confirmed:true,account_email:null,account_provider:"github",account_login:"original",signed_in_account_email:"new@example.test",signed_in_account_login:"changed"}),"GitHub account @original");
  assert.equal(installationAccountLabel({account_selection_confirmed:true,account_email:"original@example.test",signed_in_account_email:"changed@example.test"}),"original@example.test");
  for(const value of [{},{signed_in_account_provider:"github"},{signed_in_account_provider:"password",signed_in_account_login:"not-provider-proof"},{account_selection_confirmed:true,signed_in_account_email:"must-not-backfill@example.test"}]) assert.equal(installationAccountLabel(value),null);
});

test("captures one-time auth fragments before rendering and removes them from history", () => {
  const replacements = [];
  const secrets = capturePortalBootstrapSecrets(
    {
      hash: "#invitation=%20invite-secret%20&verification=verify-secret&reset=reset-secret&unsubscribe=unsubscribe-secret",
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
    resetToken: "reset-secret",
    unsubscribeToken: "unsubscribe-secret"
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
    resetToken: "",
    unsubscribeToken: ""
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
