import assert from "node:assert/strict";
import test from "node:test";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import { assertCompleteCatalogue, assertMessageContract } from "./checks.mjs";
const entries = (message, translation = message, context = "") => ({
  [generateMessageId(message, context)]: { message, translation, context },
});
test("authored completeness cannot be hidden by compiler fallback, fuzzy text or English placeholders", () => {
  const english = entries("Hello {name}");
  assert.throws(() => assertCompleteCatalogue(english, entries("Hello {name}", ""), "fr"), /before fallback/);
  assert.throws(() => assertCompleteCatalogue(english, english, "fr"), /English placeholder/);
  assert.equal(assertCompleteCatalogue(english, entries("Hello {name}", "Bonjour {name}"), "fr"), 1);
  const fuzzy = entries("Hello {name}", "Bonjour {name}");
  Object.values(fuzzy)[0].extra = { flags: ["fuzzy"] };
  assert.throws(() => assertCompleteCatalogue(english, fuzzy, "fr"), /fuzzy/);
  const properNoun = entries("mdbase");
  assert.equal(assertCompleteCatalogue(properNoun, properNoun, "fr", [generateMessageId("mdbase", "")]), 1);
  assert.throws(() => assertCompleteCatalogue(english, { custom: { message: "Hello {name}", translation: "Bonjour {name}" } }, "fr"), /keys differ/);
  assert.throws(() => assertCompleteCatalogue({ custom: { message: "Hello" } }, { custom: { message: "Hello", translation: "Bonjour" } }, "fr"), /generated/);
});
test("ICU argument and numeric rich-text contracts are enforced", () => {
  assertMessageContract("<0>Hello {name}</0>", "<0>Bonjour {name}</0>", "fr");
  for (const translated of ["Bonjour", "<1>Bonjour {name}</1>", "<0>Bonjour {person}</0>", "<script>Bonjour {name}</script>"])
    assert.throws(() => assertMessageContract("<0>Hello {name}</0>", translated, "fr"));
  assert.throws(() => assertMessageContract("{n, number}", "{n}", "de"), /types/);
  assert.throws(() => assertMessageContract("{n, select, open {Open} other {Other}}", "{n, select, shut {Zu} other {Andere}}", "de"), /cases/);
});
test("plural and ordinal categories follow target grammar; exact cases and pounds stay protected", () => {
  const english = "{n, plural, =0 {None} one {# item} other {# items}}";
  assertMessageContract(english, "{n, plural, =0 {なし} other {# 件}}", "ja");
  assertMessageContract(english, "{n, plural, =0 {Нет} one {# элемент} few {# элемента} many {# элементов} other {# элемента}}", "ru");
  assert.throws(() => assertMessageContract(english, "{n, plural, other {# 件}}", "ja"), /numeric/);
  assert.throws(() => assertMessageContract(english, "{n, plural, =0 {なし} other {件}}", "ja"), /pound/);
  assert.throws(() => assertMessageContract(english, "{n, plural, =0 {なし} one {# 件} other {# 件}}", "ja"), /category/);
  assertMessageContract("{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", "{n, selectordinal, other {第#}}", "zh");
});
