import assert from "node:assert/strict";
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";

const sorted = (set) => [...set].sort();
function shape(parts) {
  const args = new Set(), tags = new Set(), selectors = [];
  let text = "";
  for (const part of parts) {
    if (typeof part === "string") { text += part; continue; }
    const [name, type, options] = part;
    args.add(JSON.stringify([name, type ?? "argument"]));
    if (["plural", "selectordinal", "select"].includes(type)) {
      assert.ok(options && options.other, "ICU selection requires other");
      selectors.push({ name, type, options });
      for (const [key, branch] of Object.entries(options)) {
        if (key === "offset") continue;
        const child = shape(branch);
        child.args.forEach((arg) => args.add(arg));
        child.tags.forEach((tag) => tags.add(tag));
      }
    }
  }
  const stack = [];
  for (const match of text.matchAll(/<(\/?[A-Za-z0-9][^>]*)>/g)) {
    const tag = match[1];
    assert.match(tag, /^\/?\d+\/?$/, "Only numeric React placeholders are allowed");
    const id = tag.replaceAll("/", "");
    tags.add(id);
    if (tag.startsWith("/")) assert.equal(stack.pop(), id, "Unbalanced React placeholder");
    else if (!tag.endsWith("/")) stack.push(id);
  }
  assert.equal(stack.length, 0, "Unclosed React placeholder");
  return { args: sorted(args), tags: sorted(tags), selectors, pounds: (text.match(/#/g) ?? []).length };
}
/** Plural categories are language-specific; exact numeric and select cases are contracts. */
export function assertMessageContract(source, target, locale, onWarning = () => {}) {
  const check = (sourceParts, targetParts, path = []) => {
    const a = shape(sourceParts), b = shape(targetParts);
    assert.deepEqual(b.args, a.args, "ICU argument names/types changed");
    assert.deepEqual(b.tags, a.tags, "React placeholder tags changed");
    assert.equal(b.pounds, a.pounds, "ICU pound markers changed");
    assert.equal(b.selectors.length, a.selectors.length, "ICU selectors changed");
    const used = new Set();
    for (const selector of a.selectors) {
      const index = b.selectors.findIndex((s, index) => !used.has(index) && s.name === selector.name && s.type === selector.type);
      assert.ok(index >= 0, "ICU selector changed");
      used.add(index);
      const translated = b.selectors[index];
      const sourceKeys = Object.keys(selector.options).filter((k) => k !== "offset");
      const targetKeys = Object.keys(translated.options).filter((k) => k !== "offset");
      assert.equal(translated.options.offset, selector.options.offset, "ICU plural offset changed");
      if (selector.type === "select") assert.deepEqual(targetKeys.sort(), sourceKeys.sort(), "ICU select cases changed");
      else {
        const exact = (keys) => keys.filter((k) => /^=?\d/.test(k)).sort();
        for (const key of exact(sourceKeys))
          assert.ok(targetKeys.includes(key), "ICU exact numeric cases changed: missing " + key);
        const categories = new Intl.PluralRules(locale === "pt" ? "pt-BR" : locale, {
          type: selector.type === "selectordinal" ? "ordinal" : "cardinal",
        }).resolvedOptions().pluralCategories;
        for (const key of targetKeys) assert.ok(/^=?\d/.test(key) || categories.includes(key), "Invalid plural category for " + locale + ": " + key);
        const missing = (locale === "en" ? ["other"] : [...new Set([...categories, "other"])])
          .filter((key) => !targetKeys.includes(key));
        assert.equal(missing.length, 0, "Missing plural categories for " + locale + " " + selector.type + " " + selector.name + ": " + missing.join(", "));
      }
      for (const key of targetKeys) {
        const sourceBranch = selector.options[key] ?? selector.options.other;
        const targetBranch = translated.options[key];
        const branchPath = [...path, selector.name + ", " + selector.type + ", " + key];
        // Compare literal text byte-for-byte, not normalized whole-message copy.
        // Argument names and nested selector keys are not English prose.
        const text = sourceBranch.filter((part) => typeof part === "string").join("");
        if (locale !== "en" && /\p{L}/u.test(text) && JSON.stringify(targetBranch) === JSON.stringify(sourceBranch))
          onWarning("English-identical ICU branch: " + branchPath.join(" > "));
        check(sourceBranch, targetBranch, branchPath);
      }
    }
  };
  check(compileMessageOrThrow(source), compileMessageOrThrow(target));
}
export function assertCompleteCatalogue(english, target, locale, allowedIdentical = [], onWarning = console.warn) {
  const active = (entries) => Object.fromEntries(Object.entries(entries).filter(([, e]) => !e.obsolete));
  const source = active(english), translated = active(target);
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(source).sort(), locale + " active catalogue keys differ");
  for (const [id, entry] of Object.entries(translated)) {
    assert.equal(id, generateMessageId(entry.message, entry.context), "Explicit/non-generated message ID: " + id);
    assert.equal(entry.message, source[id].message, "Source message changed: " + id);
    assert.equal(entry.context ?? "", source[id].context ?? "", "Source context changed: " + id);
    assert.ok(entry.translation?.trim(), locale + " missing authored translation before fallback: " + id);
    assert.ok(!entry.extra?.flags?.includes("fuzzy"), locale + " fuzzy translation: " + id);
    const normalized = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
    if (locale !== "en" && normalized(entry.translation) === normalized(entry.message))
      assert.ok(allowedIdentical.includes(id), locale + " English placeholder (allowlist reviewed proper nouns/terms by ID): " + id);
    try {
      assertMessageContract(entry.message, entry.translation, locale, (warning) => {
        if (!allowedIdentical.includes(id)) onWarning(locale + " message " + id + ": " + warning);
      });
    }
    catch (error) { throw new Error(locale + " message " + id + ": " + error.message, { cause: error }); }
  }
  return Object.keys(translated).length;
}
