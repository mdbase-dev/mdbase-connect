import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const temporary = await mkdtemp(join(tmpdir(), "mdbase-connect-packed-api-"));

try {
  const packages = [
    ["connect-protocol", resolve(repoRoot, "packages/protocol")],
    ["connect", packageRoot],
    ["connect-testing", resolve(repoRoot, "packages/testing")]
  ];
  for (const [name, source] of packages) {
    const before = new Set(await readdir(temporary));
    await execute("pnpm", ["pack", "--pack-destination", temporary], { cwd: source });
    const archive = (await readdir(temporary)).find(
      (entry) => entry.endsWith(".tgz") && !before.has(entry)
    );
    if (!archive) throw new Error(`Packing ${name} produced no archive.`);
    const target = resolve(temporary, "node_modules/@mdbase-dev", name);
    await mkdir(target, { recursive: true });
    await execute("tar", ["-xzf", resolve(temporary, archive), "-C", target, "--strip-components=1"]);
  }

  const fixture = await readFile(resolve(packageRoot, "test/public-api/exports.ts"), "utf8");
  await writeFile(resolve(temporary, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(resolve(temporary, "fixture.ts"), `${fixture}\n
import {
  connectFailure as testingFailure,
  connectProblem as testingProblem,
  connectSuccess as testingSuccess,
  ConnectTestOutcomeError,
  installMdbaseBrowserFixture,
  requireConnectSuccess
} from "@mdbase-dev/connect-testing";
void testingFailure(testingProblem("operation_failed", "fixture"));
void requireConnectSuccess(testingSuccess({ packed: true }));
void ConnectTestOutcomeError;
void installMdbaseBrowserFixture;
`);
  await writeFile(resolve(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ["fixture.ts"]
  }, null, 2));
  await execute(resolve(packageRoot, "node_modules/.bin/tsc"), ["-p", resolve(temporary, "tsconfig.json")]);
  process.stdout.write("Packed root, /advanced, /crypto, and connect-testing boundaries compile.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
