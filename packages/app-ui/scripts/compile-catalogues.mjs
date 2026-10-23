// Strict compilation retains English fallback for development, but only the
// kit's i18n:check proves authored completeness. Always use the kit CLI so every
// package/app build prunes obsolete PO entries before compiling fallback JSON.
import { spawnSync } from "node:child_process";
const result = spawnSync("pnpm", ["exec", "mdbase-i18n", "compile"], {
  stdio: "inherit", shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
