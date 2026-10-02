import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkStyleTokens } from "../editor/scripts/check-style-tokens.mjs";

test("authentication uses the shared typography, radius, and elevation tokens", async () => {
  const css = await readFile(new URL("src/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("/* One quiet column");
  const end = css.indexOf("\n.sr-only", start);
  assert.ok(start >= 0 && end > start, "the canonical auth style block exists");
  assert.deepEqual(checkStyleTokens(css.slice(start, end), "apps/portal/src/styles.css (auth)"), []);
});
