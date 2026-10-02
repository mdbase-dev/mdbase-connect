import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStyleTokens } from "./check-style-tokens.mjs";

const check = (css) => checkStyleTokens(css, "fixture.css");

test("rejects raw pixel typography including shorthands and variable fallbacks", () => {
  assert.equal(check(".a { font-size: 13px; font: 600 12px/1.5 sans-serif; --control-font-size: 11px; }").length, 3);
  assert.equal(check(".a { font-size: var(--caption, 11px); }").length, 1);
});

test("rejects raw radii, corner radii and ad-hoc shadows", () => {
  assert.equal(check(".a { border-radius: 4px 0; border-top-left-radius: 8px; box-shadow: 0 1em 2em red; }").length, 3);
});

test("accepts tokens, non-text geometry, proportional prose and circles", () => {
  assert.deepEqual(check(`.a {
    font-size: var(--font-size-ui); font: var(--font-size-caption)/1.5 var(--sans);
    border-radius: var(--radius-sm) 0 50%; border-bottom-right-radius: 0;
    box-shadow: var(--elevation-low); width: 13px; font-size: 1.2em;
  } .b { box-shadow: none !important; }`), []);
});

test("ignores comments and string content, but not later declarations", () => {
  assert.equal(check(`/* font-size: 9px; */ .a {
    content: "font-size: 9px; border-radius: 9px";
    font-size: 11px;
  }`).length, 1);
});
