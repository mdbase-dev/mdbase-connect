import { registerHooks, stripTypeScriptTypes } from "node:module";
import { transformSync } from "@babel/core";
import { fileURLToPath } from "node:url";

// The Node presentation-helper suites run real Lingui macros through the same
// compiler as the package build. No translator or catalogue is mocked.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || url.includes("/node_modules/") || !/\.[cm]?ts$/.test(url)) return loaded;
    const source = String(loaded.source);
    if (!source.includes("@lingui/core/macro")) return loaded;
    const result = transformSync(source, {
      filename: fileURLToPath(url), configFile: false, babelrc: false,
      parserOpts: { plugins: ["typescript"] },
      plugins: [["@lingui/babel-plugin-lingui-macro", { descriptorFields: "message" }]],
    });
    return { ...loaded, format: "module", source: stripTypeScriptTypes(result.code) };
  },
});
