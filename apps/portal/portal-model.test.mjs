import assert from "node:assert/strict";
import test from "node:test";
import { message } from "./src/portal-model.ts";

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
