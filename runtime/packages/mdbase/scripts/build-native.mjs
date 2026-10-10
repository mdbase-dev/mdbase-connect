// Build the native addon with cargo and place it at native/mdbase.<tag>.node.
// Usage: node scripts/build-native.mjs [--no-build] [--from <path-to-lib>]
import { copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const fromIdx = args.indexOf("--from");

const { platform, arch } = process;
let libc = "";
if (platform === "linux") {
  const report = process.report?.getReport?.();
  libc = report?.header?.glibcVersionRuntime ? "-gnu" : "-musl";
}
const tag = `${platform}-${arch}${libc}${platform === "win32" ? "-msvc" : ""}`;
const libName = platform === "win32" ? "mdbase_node.dll" : platform === "darwin" ? "libmdbase_node.dylib" : "libmdbase_node.so";
const built = fromIdx >= 0 ? resolve(args[fromIdx + 1]) : resolve(repo, "target/node-release", libName);

if (!noBuild && fromIdx < 0) {
  execSync("cargo build --profile node-release --locked -p mdbase-node", { cwd: repo, stdio: "inherit" });
}
mkdirSync(resolve(here, "../native"), { recursive: true });
const dest = resolve(here, `../native/mdbase.${tag}.node`);
copyFileSync(built, dest);
console.log(`native addon: ${dest}`);
