// Operator tooling for the mdbase-next timer service and sealed push targets.
//
//   next-timers copy-hosted <collection id>
//       Strictly import every original timer of one fenced, drained hosted
//       collection (timers/hosted-import.ts) and print the recorded manifest.
//       DATABASE_URL: control database. MDBASE_LEGACY_PROVIDER_DATABASE_URL: the
//       legacy provider database, read through a SELECT-only role.
//       MDBASE_CONNECT_HOSTED_PROVIDER_*: the provider API, for its watermark.
//       MDBASE_OPERATOR: who runs the import (audited).
//   next-timers seal-push-targets
//       Seal plaintext push targets, and re-seal ones under a previous key, with
//       MDBASE_NEXT_PUSH_TOKEN_KEY.
//   next-timers unseal-push-targets
//       Rollback aid: restore plaintext targets before running a release that
//       predates sealing.
import { createDatabase, openDatabase } from "../../../db.js";
import { HostedProviderClient } from "../../../hosted-provider.js";
import { hostedProviderConfigFromEnv } from "../../../runtime-config.js";
import { legacyTimerGrantResolver } from "./grants.js";
import { importHostedCollectionTimers, TimerImportRefused } from "./hosted-import.js";
import { TimerError } from "./model.js";
import {
  PushTargetSealer,
  parsePushTargetSealerEnv,
  sealExistingPushTargets,
  unsealPushTargets
} from "../push-target-seal.js";

const [command, argument] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === "copy-hosted") {
    if (!argument || !/^[0-9a-f-]{36}$/i.test(argument)) throw new Error("usage: next-timers copy-hosted <collection id>");
    const sourceUrl = process.env.MDBASE_LEGACY_PROVIDER_DATABASE_URL?.trim();
    const actor = process.env.MDBASE_OPERATOR?.trim() ?? "";
    const providerConfig = hostedProviderConfigFromEnv(process.env);
    if (!process.env.DATABASE_URL || !sourceUrl || !providerConfig || !actor || actor.length > 200) {
      throw new Error("DATABASE_URL, MDBASE_LEGACY_PROVIDER_DATABASE_URL, the hosted provider configuration and MDBASE_OPERATOR are required.");
    }
    const db = await createDatabase(process.env.DATABASE_URL);
    const source = await openDatabase(sourceUrl);
    try {
      const manifest = await importHostedCollectionTimers({
        db, source, provider: new HostedProviderClient(providerConfig), resolver: legacyTimerGrantResolver,
        collection: argument, actor
      });
      console.log(JSON.stringify({ command, manifest }));
    } finally {
      await source.end();
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
  console.error(error instanceof TimerImportRefused || error instanceof TimerError
    ? JSON.stringify({ error: error.code, message: error.message })
    : error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
