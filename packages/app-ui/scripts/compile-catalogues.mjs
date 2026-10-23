// Ordinary development builds retain Lingui's English fallback while translators
// author PO files. Release/CI MUST run the kit's strict i18n:check first; compiling
// fallback JSON is never evidence that a target catalogue is complete.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(new URL("../package.json", import.meta.url));
const cli = resolve(dirname(require.resolve("@lingui/cli")), "lingui.js");
const result = spawnSync(process.execPath, [cli, "compile", "--workers", "1"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
