import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = resolve(
  process.env.MDBASE_SPEC_DIR ?? join(root, "..", "mdbase-spec")
);
const sourceRoot = join(
  specRoot,
  "standard-packs",
  "mdbase-runtime",
  "0.2.0",
  "schemas"
);
const targetRoot = join(root, "crates", "connect-runtime", "contracts");
const contracts = [
  "mdbase.record.created",
  "mdbase.record.modified",
  "mdbase.record.deleted",
  "mdbase.record.renamed",
  "mdbase.runtime.timer.fired"
];

await mkdir(targetRoot, { recursive: true });
for (const id of contracts) {
  await cp(
    join(sourceRoot, id, "1.0.0.schema.json"),
    join(targetRoot, `${id}-1.0.0.schema.json`)
  );
}

console.log(
  `Synced ${contracts.length} Runtime 0.2 event schemas from ${sourceRoot}.`
);
