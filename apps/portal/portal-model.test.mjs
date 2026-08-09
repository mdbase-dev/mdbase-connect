import assert from "node:assert/strict";
import test from "node:test";
import { capturePortalBootstrapSecrets, message } from "./src/portal-model.ts";

test("captures one-time auth fragments before rendering and removes them from history", () => {
  const replacements = [];
  const secrets = capturePortalBootstrapSecrets(
    {
      hash: "#invitation=%20invite-secret%20&reset=reset-secret",
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

  assert.deepEqual(secrets, { invitationToken: "", resetToken: "" });
  assert.equal(replaced, false);
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
