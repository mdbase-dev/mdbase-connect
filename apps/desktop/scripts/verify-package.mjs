import { execFileSync } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const out = join(desktopRoot, "out");
const candidates = await readdir(out, { withFileTypes: true });
const packageDirectory = candidates
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mdbase connect-"))
  .map((entry) => join(out, entry.name))
  .at(0);
if (!packageDirectory) throw new Error("Electron Forge did not create a packaged application.");

const extension = process.platform === "win32" ? ".exe" : "";
const resourceRoot = process.platform === "darwin"
  ? join(packageDirectory, "mdbase connect.app", "Contents", "Resources")
  : join(packageDirectory, "resources");
const daemon = join(resourceRoot, "mdbase-next", `mdbase${extension}`);
const required = [join(resourceRoot, "app.asar"), daemon, join(resourceRoot, "mdbase-next", "VERSION")];
for (const path of required) {
  await access(path);
  if ((await stat(path)).size === 0) throw new Error(`Packaged resource is empty: ${path}`);
}
// The old connector binary is not shipped.
await access(join(resourceRoot, `mdbase${extension}`)).then(
  () => { throw new Error("The package still contains the old connector binary."); },
  () => undefined
);
const version = (await readFile(join(resourceRoot, "mdbase-next", "VERSION"), "utf8")).trim();
const reported = String(execFileSync(daemon, ["--version"], { timeout: 10_000 })).trim().split(/\s+/).at(-1);
if (reported !== version) throw new Error(`Bundled daemon reports ${reported}, VERSION says ${version}.`);
process.stdout.write(`Verified packaged desktop resources in ${packageDirectory}\n`);
