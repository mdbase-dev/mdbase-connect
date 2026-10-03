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
  assert.equal(check(".a { border-radius: .25rem; }").length, 1);
});

test("accepts tokens, non-text geometry, proportional prose and circles", () => {
  assert.deepEqual(check(`.a {
    font-size: var(--font-size-ui); font: var(--font-size-caption)/1.5 var(--sans);
    border-radius: var(--radius-sm) 0 50%; border-bottom-right-radius: 0;
    box-shadow: var(--elevation-low); width: 13px; font-size: 1.2em;
  } .b { box-shadow: none !important; }`), []);
});

test("rejects malformed easing references and reports the declaration line", () => {
  assert.equal(check(".a { transition: opacity var(--motion-base) var(--var(--ease-out)); }").length, 1);
  assert.match(check(".a {\n  font-size: 11px;\n}")[0], /fixture\.css:2:/);
});

test("rejects forced uppercase/title case but allows the lowercase wordmark", () => {
  assert.equal(check(".a { text-transform: uppercase; } .b { text-transform: capitalize; }").length, 2);
  assert.deepEqual(check(".wordmark { text-transform: lowercase; } .label { text-transform: none; }"), []);
  assert.match(check(".a { text-transform: uppercase; }")[0], /sentence-case/);
});

test("ignores comments and string content, but not later declarations", () => {
  assert.equal(check(`/* font-size: 9px; */ .a {
    content: "font-size: 9px; border-radius: 9px";
    font-size: 11px;
  }`).length, 1);
});
