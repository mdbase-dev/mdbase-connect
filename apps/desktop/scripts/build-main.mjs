import { build } from "esbuild";
import { transformAsync } from "@babel/core";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";

await rm("dist/main", { recursive: true, force: true });
await build({
  entryPoints: [
    "src/main/main.ts",
    "src/main/i18n.ts",
    "src/main/approval-url.ts",
    "src/main/ipc-trust.ts",
    "src/main/preload.ts",
    "src/main/boot-gate.ts",
    "src/main/deep-link.ts",
    "src/main/editor-url.ts",
    "src/main/electron-update-backend.ts",
    "src/main/process-output.ts",
    "src/main/release-source.ts",
    "src/main/update-coordinator.ts",
    "src/main/update-download.ts",
    "src/main/update-policy.ts",
    "src/main/update-state.ts",
    "src/main/next-daemon.ts",
    "src/main/daemon-client.ts",
    "src/main/daemon-cli.ts",
    "src/main/daemon-session.ts",
    "src/main/daemon-runtime.ts"
  ],
  plugins: [{ name: "lingui-macros", setup(builder) {
    builder.onLoad({ filter: /\.[cm]?tsx?$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      if (!source.includes("@lingui/core/macro")) return;
      const result = await transformAsync(source, {
        filename: path, configFile: false, babelrc: false,
        parserOpts: { plugins: ["typescript"] },
        plugins: [["@lingui/babel-plugin-lingui-macro", { descriptorFields: "message" }]],
      });
      return { contents: result.code, loader: "ts" };
    });
  } }],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: "dist/main",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info"
});
