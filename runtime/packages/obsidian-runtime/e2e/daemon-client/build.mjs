import { build } from "esbuild";
import { mkdirSync, copyFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const required = name => { if (!process.env[name]) throw new Error(`required ${name}`); return resolve(process.env[name]); };
const sdk = required("LAB_SDK_DIST");
const adapter = required("LAB_WRITE_CLIENT_SOURCE");
const backend = required("LAB_TASKNOTES_BACKEND_SOURCE");
const fixture = required("LAB_FIXTURE_FILE");
const status = required("LAB_STATUS_FILE");
const out = process.env.LAB_CLIENT_OUT ? resolve(process.env.LAB_CLIENT_OUT) : join(here, "../.work/daemon-client-bundle");
for (const file of [join(sdk, "index.js"), join(sdk, "node.js"), adapter, backend, fixture, status]) if (!statSync(file).isFile()) throw new Error("missing build input");
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(here, "main.ts")], bundle: true, outfile: join(out, "main.js"),
  format: "cjs", platform: "node", target: "es2022", external: ["obsidian", "electron", "node:*"],
  alias: { "@mdbase-lab/sdk/node": join(sdk, "node.js"), "@mdbase-lab/sdk": join(sdk, "index.js"),
    "@mdbase-lab/write-client": adapter, "@mdbase-lab/tasknotes-backend": backend },
  define: { LAB_FIXTURE_FILE: JSON.stringify(fixture), LAB_STATUS_FILE: JSON.stringify(status) }, logLevel: "warning" });
copyFileSync(join(here, "manifest.json"), join(out, "manifest.json"));
writeFileSync(join(out, "artifact.json"), JSON.stringify({ kind: "lab-test-only", bytes: statSync(join(out, "main.js")).size,
  sdkHead: process.env.LAB_SDK_HEAD, writeClientHead: process.env.LAB_WRITE_CLIENT_HEAD, tasknotesHead: process.env.LAB_TASKNOTES_HEAD }, null, 2));
console.log(JSON.stringify({ artifact: out, bytes: statSync(join(out, "main.js")).size }));
