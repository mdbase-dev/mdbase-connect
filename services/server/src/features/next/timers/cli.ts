// Operator tooling for sealed push targets.
//
//   next-timers seal-push-targets
//       Seal plaintext push targets, and re-seal ones under a previous key, with
//       MDBASE_NEXT_PUSH_TOKEN_KEY.
//   next-timers unseal-push-targets
//       Rollback aid: restore plaintext targets before running a release that
//       predates sealing.
import { createDatabase } from "../../../db.js";
import { TimerError } from "./model.js";
import {
  PushTargetSealer,
  parsePushTargetSealerEnv,
  sealExistingPushTargets,
  unsealPushTargets
} from "../push-target-seal.js";

const [command] = process.argv.slice(2);

async function main(): Promise<void> {
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
  throw new Error("usage: next-timers seal-push-targets | unseal-push-targets");
}

main().catch((error: unknown) => {
  console.error(error instanceof TimerError
    ? JSON.stringify({ error: error.code, message: error.message })
    : error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
