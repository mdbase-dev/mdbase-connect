import { access, readdir, stat } from "node:fs/promises";
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
const required = [
  join(resourceRoot, "app.asar"),
  join(resourceRoot, `mdbase${extension}`)
];
for (const path of required) {
  await access(path);
  if ((await stat(path)).size === 0) throw new Error(`Packaged resource is empty: ${path}`);
}
process.stdout.write(`Verified packaged desktop resources in ${packageDirectory}\n`);
