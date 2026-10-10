import { build } from "esbuild";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateScenarioMode } from "./diagnostics.mjs";
const scenarioMode = validateScenarioMode(process.env.LAB_UI_MODE ?? "full_ui");
const here = dirname(fileURLToPath(import.meta.url));
const required = name => { if (!process.env[name]) throw new Error(`required ${name}`); return process.env[name]; };
const path = name => resolve(required(name));
const sdk = path("LAB_SDK_DIST"), adapter = path("LAB_WRITE_CLIENT_SOURCE"), tn = path("LAB_TASKNOTES_SOURCE_ROOT");
const fixture = path("LAB_FIXTURE_FILE"), status = path("LAB_STATUS_FILE");
const tnHead = required("LAB_TASKNOTES_HEAD"), writeHead = required("LAB_WRITE_CLIENT_HEAD"), sdkHead = required("LAB_SDK_HEAD");
for (const head of [tnHead, writeHead, sdkHead]) if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("full immutable heads required");
if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: tn, encoding: "utf8" }).trim() !== tnHead) throw new Error("TaskNotes source head mismatch");
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: tn, encoding: "utf8" }).trim()) throw new Error("dirty TaskNotes source");
const inventory = path("LAB_SDK_INVENTORY");
let sdkJsFiles = 0;
for (const line of readFileSync(inventory, "utf8").trim().split("\n")) {
  const match = /^([0-9a-f]{64})\s+dist\/(.+\.js)$/.exec(line);
  if (!match) continue;
  const file = resolve(sdk, match[2]);
  if (!file.startsWith(sdk + sep) || createHash("sha256").update(readFileSync(file)).digest("hex") !== match[1]) throw new Error("SDK inventory mismatch");
  sdkJsFiles++;
}
if (!sdkJsFiles) throw new Error("empty SDK inventory");
const repo = resolve(here, "../../../..");
const pinnedAdapter = execFileSync("git", ["show", `${writeHead}:packages/obsidian-runtime/src/client/writeClient.ts`], { cwd: repo });
if (!pinnedAdapter.equals(readFileSync(adapter))) throw new Error("write adapter does not match pinned blob");
const out = process.env.LAB_UI_OUT ? resolve(process.env.LAB_UI_OUT) : join(here, "../.work/tasknotes-ui-bundle");
const source = rel => join(tn, rel);
for (const file of [join(sdk, "index.js"), join(sdk, "node.js"), fixture, status, source("src/main.ts"), source("styles.css"), source("manifest.json")]) {
  if (!statSync(file).isFile()) throw new Error("missing build input");
}
mkdirSync(out, { recursive: true, mode: 0o700 });
await build({ entryPoints: [join(here, "main.ts")], bundle: true, outfile: join(out, "main.js"),
  format: "cjs", platform: "node", target: "es2022", charset: "utf8", treeShaking: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, "node:*"],
  loader: { ".md": "text" },
  alias: { "@mdbase-lab/sdk/node": join(sdk, "node.js"), "@mdbase-lab/sdk": join(sdk, "index.js"),
    "@mdbase-lab/write-client": adapter,
    "@mdbase-lab/tasknotes-main": source("src/main.ts"),
    "@mdbase-lab/tasknotes-create-modal": source("src/modals/TaskCreationModal.ts"),
    "@mdbase-lab/tasknotes-edit-modal": source("src/modals/TaskEditModal.ts"),
    "@mdbase-lab/tasknotes-vault-service": source("src/core/VaultMutationService.ts"),
    "@mdbase-lab/tasknotes-backend": source("src/core/mdbase/MdbaseMutationBackend.ts") },
  define: { LAB_FIXTURE_FILE: JSON.stringify(fixture), LAB_STATUS_FILE: JSON.stringify(status), LAB_UI_MODE: JSON.stringify(scenarioMode) }, logLevel: "warning" });
const manifest = JSON.parse(readFileSync(source("manifest.json"), "utf8"));
if (manifest.id !== "tasknotes") throw new Error("unexpected full plugin id");
writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...manifest, name: "TaskNotes (isolated LAB UI)", isDesktopOnly: true }, null, 2), { mode: 0o600 });
copyFileSync(source("styles.css"), join(out, "styles.css"));
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const artifact = { kind: "lab-test-only-full-tasknotes", scenarioMode, tasknotesHead: tnHead, writeClientHead: writeHead, sdkHead,
  sdkInventorySha: sha(inventory), sdkJsFiles,
  backendInstallation: "same-bundle VaultMutationService singleton BEFORE inherited full-plugin onload/CoreServices metadata initialization",
  scope: scenarioMode === "negative_initialization" ? "negative-initialization-only; no modal/TaskService CRUD or UI acceptance" : "modal-create-save/full-TaskService-update/edit-modal-render; no dirty-editor/cloud/mobile activation",
  bytes: statSync(join(out, "main.js")).size,
  harnessFiles: Object.fromEntries(["main.ts", "guard.mjs", "diagnostics.mjs", "build.mjs", "run-ui.mjs"].map(name => [name, sha(join(here, name))])),
  files: Object.fromEntries(["main.js", "manifest.json", "styles.css"].map(name => [name, sha(join(out, name))])),
  sdkFiles: Object.fromEntries(["index.js", "node.js"].map(name => [name, sha(join(sdk, name))])) };
writeFileSync(join(out, "artifact.json"), JSON.stringify(artifact, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ artifact: out, ...artifact }));
