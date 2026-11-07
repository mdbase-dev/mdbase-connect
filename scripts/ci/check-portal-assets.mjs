import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { managedEnvironments } from "../lib/managed-environments.mjs";

export async function checkBuiltAssets(directory = fileURLToPath(new URL("../../apps/portal/dist/", import.meta.url))) {
  const accountIds = Object.values(managedEnvironments)
    .flatMap(environment => environment.cloudflareAccountId ? [environment.cloudflareAccountId] : []);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkBuiltAssets(path);
    } else if (entry.isFile()) {
      const contents = await readFile(path);
      if (accountIds.some(accountId => contents.includes(accountId))) {
        throw new Error("Portal build contains a deployment account identifier.");
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkBuiltAssets();
}
