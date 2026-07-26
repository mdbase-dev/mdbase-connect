import { build } from "esbuild";

await build({
  entryPoints: [
    "src/main/main.ts",
    "src/main/preload.ts"
  ],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: "dist/main",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info"
});
