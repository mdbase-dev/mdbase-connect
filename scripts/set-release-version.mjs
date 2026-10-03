import { prepareVersion } from "./lib/release-version.mjs";

const [version, flag, ...extra] = process.argv.slice(2);
if (extra.length || (flag && flag !== "--dry-run")) throw new Error("Usage: pnpm version:set 0.1.0-beta.N [--dry-run]");
const plan = await prepareVersion(process.cwd(), version, { dryRun: flag === "--dry-run" });
for (const file of plan.updates.keys()) console.log(`update ${file}`);
for (const file of plan.removals) console.log(`consume ${file}`);
