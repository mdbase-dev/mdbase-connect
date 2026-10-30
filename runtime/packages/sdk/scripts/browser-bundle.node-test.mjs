import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { buildBrowserBundles } from "./build-browser.mjs";

const directory = fileURLToPath(new URL("..", import.meta.url));
let bundles;
let root;
let client;
let appHost;

function evaluate(text, name) {
  const context = createContext({
    TextEncoder,
    TextDecoder,
    URL,
    fetch() { throw new Error("Bundle import must not perform I/O"); },
    indexedDB: new Proxy({}, { get() { throw new Error("Bundle import must not access storage"); } }),
    crypto: new Proxy({}, { get() { throw new Error("Bundle import must not use custody/entropy"); } }),
  });
  context.window = context;
  runInContext(text, context, { timeout: 5_000 });
  return { value: context[name], context };
}

async function surface(entry) {
  const result = await build({
    absWorkingDir: directory, entryPoints: [entry], bundle: true, platform: "browser",
    format: "iife", globalName: "Expected", write: false,
  });
  return evaluate(result.outputFiles[0].text, "Expected").value;
}

before(async () => {
  bundles = await buildBrowserBundles({ write: false });
  root = await surface("src/index.ts");
  client = await surface("src/client.ts");
  appHost = await surface("src/app-host/index.ts");
});

for (const [index, label] of ["unminified", "minified"].entries()) {
  test(`${label}: classic-script root/client/app-host exports with no import-time effects`, () => {
    const { value: sdk, context } = evaluate(bundles[index].outputFiles[0].text, "MdbaseSDK");
    assert.ok(sdk);
    assert.equal(context.window.MdbaseSDK, sdk);
    assert.equal(context.MdbaseConnect, undefined);
    assert.deepEqual(Object.keys(sdk).sort(), [...Object.keys(root), "Client", "AppHost"].sort());
    assert.deepEqual(Object.keys(sdk.Client).sort(), Object.keys(client).sort());
    assert.deepEqual(Object.keys(sdk.AppHost).sort(), Object.keys(appHost).sort());
    assert.equal(sdk.Client.MdbaseClient, sdk.MdbaseClient);
    assert.equal(typeof sdk.AppHost.AppProtectedInstallationSignIn, "function");
    assert.equal(typeof sdk.AppHost.AppWasmRuntime, "function");
    assert.deepEqual(Array.from(sdk.decode(sdk.encode([1, "browser", true, null]))), [1, "browser", true, null]);
  });

  test(`${label}: bundled browser dependencies exclude Node and test-only entry points`, () => {
    const inputs = Object.keys(bundles[index].metafile.inputs);
    assert.ok(inputs.includes("src/browser.ts"));
    assert.ok(!inputs.some(path => path === "src/node.ts" || path.startsWith("src/testing/") || path.startsWith("test/")));
    for (const output of Object.values(bundles[index].metafile.outputs)) {
      assert.deepEqual(output.imports, []);
    }
  });
}

test("ESM root defers session runtime and collection setup until activation", async () => {
  const { metafile } = await build({
    absWorkingDir: directory, entryPoints: ["src/index.ts"], bundle: true, platform: "browser",
    format: "esm", splitting: true, outdir: "bundle-test-out", write: false, metafile: true,
  });
  const outputs = metafile.outputs;
  const initial = new Set(Object.keys(outputs).filter(path => outputs[path].entryPoint === "src/index.ts"));
  assert.equal(initial.size, 1);
  for (const path of initial) {
    for (const imported of outputs[path].imports) {
      if (imported.kind === "import-statement" && outputs[imported.path]) initial.add(imported.path);
    }
  }
  for (const input of ["src/application/runtime.ts", "src/application/configuration.ts"]) {
    assert.ok(Object.values(outputs).some(output => input in output.inputs), `${input} remains available`);
    assert.ok(![...initial].some(path => input in outputs[path].inputs), `${input} must load lazily`);
  }
});

test("browser build is reproducible from unchanged inputs", async () => {
  const repeat = await buildBrowserBundles({ write: false });
  for (let i = 0; i < bundles.length; i++) {
    assert.deepEqual(repeat[i].outputFiles[0].contents, bundles[i].outputFiles[0].contents);
  }
});
