// Pack this package and consume it from a fresh npm project, the way a user
// would: `npm install <tarball>`, then run the README quickstarts for both
// entry points. Usage: node scripts/clean-install.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mdbase-clean-install-"));
try {
  const tarball = execSync("npm pack --silent", { cwd: pkg, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execSync(`npm install --no-audit --no-fund ${join(pkg, tarball)}`, { cwd: dir, stdio: "inherit" });
  writeFileSync(
    join(dir, "smoke.mjs"),
    `
import { contractDigest, loadCatalog } from "mdbase";
import { Collection } from "mdbase/node";
import { mkdirSync } from "node:fs";

const c = await contractDigest("---\\nkind: mdbase.contract\\ncontract_type: record\\nid: example.note\\nversion: 1.0.0\\nrecord_schema:\\n  dialect: json-schema-2020-12\\n  value:\\n    type: object\\n---\\n");
if (!c.digest.startsWith("sha256:")) throw new Error("digest");
const cat = await loadCatalog({ "mdbase.yaml": 'spec_version: "0.3.0"\\n' });
if (!cat.valid) throw new Error("catalog");

const root = "${join(dir, "notes").replace(/\\/g, "\\\\")}";
mkdirSync(root, { recursive: true });
const col = await Collection.init(root, { name: "Smoke" });
const t = await col.create({ path: "tasks/a.md", frontmatter: { status: "open" }, body: "Hi\\n" });
const open = await col.query({ where: "status == 'open'" });
if (open.records.length !== 1) throw new Error("query");
await col.update(t, { set: { status: "done" }, ifRevision: t.revision });
await col.delete("tasks/a.md");
await col.close();
console.log("mdbase clean install (npm): ok");
`,
  );
  execSync("node smoke.mjs", { cwd: dir, stdio: "inherit" });
  rmSync(join(pkg, tarball), { force: true });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
