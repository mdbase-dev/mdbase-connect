// Operator tooling for the mdbase-next timer service and sealed push targets.
//
//   next-timers copy-hosted <collection id>
//       Fails closed until the strict original-timer importer and authenticated
//       paged caller are integrated. The former lossy importer is not usable.
//   next-timers seal-push-targets
//       Seal plaintext push targets, and re-seal ones under a previous key, with
//       MDBASE_NEXT_PUSH_TOKEN_KEY.
//   next-timers unseal-push-targets
//       Rollback aid: restore plaintext targets before running a release that
//       predates sealing.
import { createDatabase } from "../../../db.js";
import {
  PushTargetSealer,
  parsePushTargetSealerEnv,
  sealExistingPushTargets,
  unsealPushTargets
} from "../push-target-seal.js";

class TimerImportRequiresStrictImporterError extends Error {
  readonly code = "timer_import_requires_strict_importer";
  constructor() {
    super("Timer import requires the strict original-timer importer and authenticated paged caller.");
    this.name = "TimerImportRequiresStrictImporterError";
  }
}

const [command, argument] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === "copy-hosted") {
    if (!argument || !/^[0-9a-f-]{36}$/i.test(argument)) throw new Error("usage: next-timers copy-hosted <collection id>");
    throw new TimerImportRequiresStrictImporterError();
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
  console.error(error instanceof TimerImportRequiresStrictImporterError
    ? JSON.stringify({ error: error.code, message: error.message })
    : error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
