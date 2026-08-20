#!/usr/bin/env node

import { checkWorkspacePins } from "./lib/workspace-pins.mjs";

const result = await checkWorkspacePins(process.cwd());
for (const failure of result.failures) console.error(`- ${failure}`);
if (result.failures.length > 0) {
  console.error(
    "\nSibling checkouts disagree with what this workspace pins. CI clones the pinned\n" +
    "revisions into a clean tree and cannot reproduce this, so the resulting build or\n" +
    "test failure will not look like a checkout problem."
  );
  process.exitCode = 1;
} else {
  console.log(
    `Workspace pin check passed: ${result.repositoryCount} repositories, ` +
    `${result.checked.length} agreement(s) verified.`
  );
}
