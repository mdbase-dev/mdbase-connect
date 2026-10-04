// Operator tooling for the mdbase-next timer service and sealed push targets.
//
//   next-timers copy-hosted <collection id>
//       Copy a hosted collection's active legacy timers into next_timers (cutover,
//       migration H10). Reads the hosted provider's database at
//       MDBASE_NEXT_PROVIDER_DATABASE_URL and writes DATABASE_URL. Idempotent.
//   next-timers seal-push-targets
//       Seal plaintext push targets, and re-seal ones under a previous key, with
//       MDBASE_NEXT_PUSH_TOKEN_KEY.
//   next-timers unseal-push-targets
//       Rollback aid: restore plaintext targets before running a release that
//       predates sealing.
import { createDatabase, openDatabase } from "../../../db.js";
import {
  PushTargetSealer,
  parsePushTargetSealerEnv,
  sealExistingPushTargets,
  unsealPushTargets
} from "../push-target-seal.js";
import { legacyTimerGrantResolver } from "./grants.js";
import { readHostedLegacyTimers } from "./hosted-copy.js";
import { importLegacyTimers } from "./routes.js";

const [command, argument] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === "copy-hosted") {
    if (!argument || !/^[0-9a-f-]{36}$/i.test(argument)) throw new Error("usage: next-timers copy-hosted <collection id>");
    const providerUrl = process.env.MDBASE_NEXT_PROVIDER_DATABASE_URL;
    if (!providerUrl) throw new Error("MDBASE_NEXT_PROVIDER_DATABASE_URL is required.");
    const provider = await openDatabase(providerUrl);
    const db = await createDatabase();
    try {
      const { timers, skipped } = await readHostedLegacyTimers(provider, argument);
      const result = await importLegacyTimers(db, legacyTimerGrantResolver, timers);
      console.log(JSON.stringify({ collection: argument, read: timers.length, unrecognized: skipped, ...result }));
    } finally {
      await provider.end();
      await db.end();
    }
    return;
  }
  if (command === "seal-push-targets" || command === "unseal-push-targets") {
    const config = parsePushTargetSealerEnv(process.env);
    if (!config) throw new Error("MDBASE_NEXT_PUSH_TOKEN_KEY is required.");
    const db = await createDatabase();
    try {
      const sealer = new PushTargetSealer(config);
      const changed = command === "seal-push-targets"
        ? await sealExistingPushTargets(db, sealer)
        : await unsealPushTargets(db, sealer);
      console.log(JSON.stringify({ command, changed }));
    } finally {
      await db.end();
    }
    return;
  }
  throw new Error("usage: next-timers copy-hosted <collection id> | seal-push-targets | unseal-push-targets");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
