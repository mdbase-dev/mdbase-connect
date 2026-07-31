import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist/main", { recursive: true, force: true });
await build({
  entryPoints: [
    "src/main/main.ts",
    "src/main/preload.ts",
    "src/main/agent-startup.ts",
    "src/main/editor-url.ts",
    "src/main/electron-update-backend.ts",
    "src/main/release-source.ts",
    "src/main/update-coordinator.ts",
    "src/main/update-download.ts",
    "src/main/update-policy.ts",
    "src/main/update-state.ts"
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
