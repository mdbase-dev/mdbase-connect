#!/usr/bin/env node

import { evaluateArchitecture } from "./lib/architecture-check.mjs";

const failures = await evaluateArchitecture(process.cwd());
for (const failure of failures) console.error(`- ${failure}`);
if (failures.length > 0) process.exitCode = 1;
else console.log("Architecture check passed.");
