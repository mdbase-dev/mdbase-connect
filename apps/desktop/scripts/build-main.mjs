import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist/main", { recursive: true, force: true });
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
