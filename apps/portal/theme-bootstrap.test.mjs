import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./public/theme-bootstrap.js", import.meta.url), "utf8");

test("authorization requests always start with the system theme", () => {
  const context = themeContext("/authorize/11111111-1111-4111-8111-111111111111", "dark", false);

  vm.runInNewContext(source, context);

  assert.equal(context.document.documentElement.dataset.theme, undefined);
  assert.equal(context.themeColor, "#fcfcfd");
});

test("other portal pages keep the saved theme preference", () => {
  const context = themeContext("/", "dark", false);

  vm.runInNewContext(source, context);

  assert.equal(context.document.documentElement.dataset.theme, "dark");
  assert.equal(context.themeColor, "#1c1e24");
});

function themeContext(pathname, savedTheme, systemDark) {
  const context = {
    location: { pathname },
    localStorage: { getItem: () => savedTheme },
    matchMedia: () => ({ matches: systemDark }),
    themeColor: "",
    document: {
      documentElement: { dataset: {} },
      querySelector: () => ({
        setAttribute: (_name, value) => {
          context.themeColor = value;
        }
      })
    }
  };
  return context;
}
