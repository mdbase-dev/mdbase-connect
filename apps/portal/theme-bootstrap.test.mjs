import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./public/theme-bootstrap.js", import.meta.url), "utf8");

for (const pathname of ["/", "/login", "/signup", "/device", "/authorize/11111111-1111-4111-8111-111111111111"]) {
  for (const [savedTheme, systemDark, expected, color] of [
    ["dark", false, "dark", "#1c1e24"],
    ["light", true, "light", "#fcfcfd"],
    ["system", true, undefined, "#1c1e24"],
    ["system", false, undefined, "#fcfcfd"]
  ]) {
    test(`${pathname}: ${savedTheme} with OS ${systemDark ? "dark" : "light"} before first paint`, () => {
      const context = themeContext(pathname, savedTheme, systemDark);
      vm.runInNewContext(source, context);
      assert.equal(context.document.documentElement.dataset.theme, expected);
      assert.equal(context.themeColor, color);
    });
  }
}

function themeContext(pathname, savedTheme, systemDark) {
  const context = {
    location: { pathname },
    localStorage: { getItem: () => savedTheme },
    matchMedia: () => ({ matches: systemDark }),
    themeColor: "",
    document: {
      documentElement: { dataset: {} },
      querySelector: () => ({
        setAttribute: (_name, value) => { context.themeColor = value; }
      })
    }
  };
  return context;
}
