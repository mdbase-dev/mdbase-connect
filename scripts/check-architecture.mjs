#!/usr/bin/env node

import { checkArchitecture } from "./lib/architecture-check.mjs";

const result = await checkArchitecture(process.cwd());
for (const failure of result.failures) console.error(`- ${failure}`);
if (result.failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `Architecture check passed: ${result.productionFileCount} production files, ` +
    `${result.relativeImportCount} relative imports, ` +
    `${result.workspacePackageCount} workspace packages.`
  );
}
