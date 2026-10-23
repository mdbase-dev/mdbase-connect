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

for (const [locale, cardinal, ordinal] of [
  ["ru", ["one", "few", "many", "other"], ["other"]],
  ["ja", ["other"], ["other"]],
  ["ko", ["other"], ["other"]],
  ["de", ["one", "other"], ["other"]],
  ["fr", ["one", "many", "other"], ["one", "other"]],
  ["pt", ["one", "many", "other"], ["other"]],
]) {
  for (const [type, categories] of [["plural", cardinal], ["selectordinal", ordinal]]) {
    test(locale + " " + type + " requires all CLDR categories and rejects unknown categories", () => {
      const source = "{n, " + type + ", one {# item} other {# items}}";
      const message = (keys) => "{n, " + type + ", " + keys.map((key) => key + " {# 訳}").join(" ") + "}";
      assertMessageContract(source, message(categories), locale);
      for (const category of categories) {
        assert.throws(() => assertMessageContract(source, message(categories.filter((key) => key !== category)), locale),
          category === "other" ? /other|Unexpected|invalid/i : /Missing plural categories/);
      }
      const unknown = ["zero", "one", "two", "few", "many"].find((key) => !categories.includes(key));
      assert.throws(() => assertMessageContract(source, message([...categories, unknown]), locale), /Invalid plural category/);
      // Additional exact values do not replace any CLDR category.
      assertMessageContract(source, message([...categories, "=2"]), locale);
      if (categories.includes("one"))
        assert.throws(() => assertMessageContract(source, message([...categories.filter((key) => key !== "one"), "=1"]), locale), /Missing plural categories/);
    });
  }
}

test("English source exact arms need not redundantly enumerate source CLDR categories", () => {
  const source = "{n, plural, =1 {# item} other {# items}}";
  assertCompleteCatalogue(entries(source), entries(source), "en");
  assert.throws(() => assertMessageContract(source, "{n, plural, =1 {# Ding} other {# Dinge}}", "de"), /Missing plural categories.*one/);
});

test("nested plural categories are checked even in extra target-locale branches", () => {
  const source = "{gender, select, other {{n, plural, one {# item} other {# items}}}}";
  assert.throws(() => assertMessageContract(source,
    "{gender, select, other {{n, plural, one {# элемент} other {# элементов}}}}", "ru"), /few, many/);
});

test("English-identical plural/select branches warn with locale, ID and path without failing completeness", () => {
  const source = "{n, plural, one {# item} other {# items}}";
  const target = "{n, plural, one {# элемент} few {# items} many {# items} other {# элемента}}";
  const warnings = [];
  assert.equal(assertCompleteCatalogue(entries(source), entries(source, target), "ru", [], (warning) => warnings.push(warning)), 1);
  assert.equal(warnings.length, 2);
  for (const key of ["few", "many"])
    assert.ok(warnings.includes("ru message " + generateMessageId(source, "") + ": English-identical ICU branch: n, plural, " + key));
  for (const locale of ["ja", "ko"]) {
    const reports = [];
    assertCompleteCatalogue(entries(source), entries(source, "{n, plural, other {# items}}"), locale, [], (warning) => reports.push(warning));
    assert.equal(reports.length, 1);
  }
  const nested = "{gender, select, male {His {n, plural, one {# item} other {# items}}} other {Their {n, plural, one {# item} other {# items}}}}";
  const translated = "{gender, select, male {Sein {n, plural, one {# Ding} other {# items}}} other {Their {n, plural, one {# Ding} other {# Dinge}}}}";
  const reports = [];
  assertMessageContract(nested, translated, "de", (warning) => reports.push(warning));
  assert.deepEqual(reports, ["English-identical ICU branch: gender, select, male > n, plural, other"]);
  const select = "{state, select, open {Open} other {Closed}}";
  assertMessageContract(select, "{state, select, open {Open} other {Fermé}}", "fr", (warning) => reports.push(warning));
  assert.equal(reports.at(-1), "English-identical ICU branch: state, select, open");
  assertMessageContract("{n, selectordinal, one {#st} other {#th}}", "{n, selectordinal, one {#er} other {#th}}", "fr", (warning) => reports.push(warning));
  assert.equal(reports.at(-1), "English-identical ICU branch: n, selectordinal, other");
});

test("reviewed identical IDs suppress branch warnings, but never waive plural contracts", () => {
  const source = "{n, plural, one {# item} other {# items}}";
  const id = generateMessageId(source, "");
  const warnings = [];
  assertCompleteCatalogue(entries(source), entries(source, "{n, plural, other {# items}}"), "ja", [id], (warning) => warnings.push(warning));
  assert.deepEqual(warnings, []);
  assert.throws(() => assertCompleteCatalogue(entries(source), entries(source), "ru", [id]), /Missing plural categories/);
});

test("branch reports are byte-sensitive and ignore placeholders, punctuation and numeric-only text", () => {
  const source = "{state, select, open {Open} other {{name} # 123!}}";
  const reports = [];
  for (const translated of ["open", "Open ", "Öffnen"])
    assertMessageContract(source, "{state, select, open {" + translated + "} other {{name} # 123!}}", "de", (warning) => reports.push(warning));
  assertMessageContract(source, source, "en", (warning) => reports.push(warning));
  assert.deepEqual(reports, []);
});
