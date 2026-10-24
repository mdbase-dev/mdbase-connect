// PO is reviewed source; JSON is disposable build output. Compile library
// scopes first for direct app dev/test/typecheck, not only recursive builds.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const current = resolve(process.argv[2] ?? process.cwd());
const scopes = [...new Set([
  resolve(root, "packages/app-ui"),
  ...(current === resolve(root, "packages/app-ui") ? [] : [resolve(root, "packages/ui")]),
  current,
])];
for (const cwd of scopes) {
  const result = spawnSync(process.execPath, [resolve(root, "packages/i18n/scripts/bin.mjs"), "compile"], {
    cwd, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Catalogue compilation failed: " + cwd);
}
