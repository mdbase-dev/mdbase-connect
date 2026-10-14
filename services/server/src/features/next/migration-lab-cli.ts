// Operator CLI for the LAB one-account migration rehearsal (migration-lab.ts).
// Runs only with MDBASE_CONNECT_ENVIRONMENT exactly `lab`.
//
//   next-migration-lab lab-run <account id> <backup hold id> [--stop-before-flip]
//   next-migration-lab resume <account id>
//   next-migration-lab route-back <account id>
//   next-migration-lab status <account id>
//
// DATABASE_URL: control database. MDBASE_LEGACY_PROVIDER_DATABASE_URL: the legacy
// provider database through its SELECT-only reader role. MDBASE_CONNECT_HOSTED_PROVIDER_*:
// the provider API. MDBASE_OPERATOR: who runs it (audited). MDBASE_NEXT_TIMERS=1.
// MDBASE_NEXT_HOSTED_SERVICE_URL and MDBASE_NEXT_HOSTED_SERVICE_TOKEN: the hosted
// Worker's internal migration entry.
//
// Progress is one JSON line per step on stdout. An operator stop prints
// {"stopped":{step,reason,inspect,resume}} and exits 2. Nothing secret is printed.
import { createDatabase, openDatabase } from "../../db.js";
import { HostedProviderClient } from "../../hosted-provider.js";
import { captureLabWorkerError, sanitizedLabOutcome } from "./migration-lab-raw-error.js";
import { labLegacySourceConnection } from "./migration-lab-source-tls.js";
import { hostedProviderConfigFromEnv } from "../../runtime-config.js";
import { labRun, resumeLab, labStatus, labWorkerClient, postgresLabConnect, routeBack, type LabOutcome } from "./migration-lab.js";

const USAGE = "usage: next-migration-lab lab-run <account id> <backup hold id> [--stop-before-flip] | resume <account id> | route-back <account id> | status <account id>";

async function main(argv: string[]): Promise<void> {
  // The environment is checked before anything else is read or opened.
  if (process.env.MDBASE_CONNECT_ENVIRONMENT !== "lab") throw new Error("next-migration-lab runs only with MDBASE_CONNECT_ENVIRONMENT=lab.");
  const [command, account, hold, flag] = argv;
  const stopBeforeFlip = flag === "--stop-before-flip";
  if (!account || (command === "lab-run" ? !hold || !(argv.length === 3 || argv.length === 4 && stopBeforeFlip)
    : argv.length !== 2 || !["route-back", "resume", "status"].includes(command!))) {
    throw new Error(USAGE);
  }
  const sourceUrl = process.env.MDBASE_LEGACY_PROVIDER_DATABASE_URL?.trim();
  const actor = process.env.MDBASE_OPERATOR?.trim() ?? "";
  const providerConfig = hostedProviderConfigFromEnv(process.env);
  if (!process.env.DATABASE_URL || !sourceUrl || !providerConfig || !actor || actor.length > 200
      || process.env.MDBASE_NEXT_TIMERS !== "1" || !process.env.MDBASE_NEXT_HOSTED_SERVICE_URL || !process.env.MDBASE_NEXT_HOSTED_SERVICE_TOKEN) {
    throw new Error("DATABASE_URL, MDBASE_LEGACY_PROVIDER_DATABASE_URL, the hosted provider configuration, MDBASE_OPERATOR, "
      + "MDBASE_NEXT_TIMERS=1, MDBASE_NEXT_HOSTED_SERVICE_URL and MDBASE_NEXT_HOSTED_SERVICE_TOKEN are required.");
  }
  const worker = labWorkerClient({ url: process.env.MDBASE_NEXT_HOSTED_SERVICE_URL, token: process.env.MDBASE_NEXT_HOSTED_SERVICE_TOKEN.trim(),
    environment: process.env.MDBASE_CONNECT_ENVIRONMENT });
  // An explicit LAB-only owner identity, supplied by approved custody, not an
  // inferred URI role or a fallback to DATABASE_URL. Never applies to control DB.
  const ownerReadonlyRole = process.env.MDBASE_LEGACY_PROVIDER_LAB_OWNER_READONLY_ROLE;
  if (ownerReadonlyRole !== undefined && (command !== "lab-run" || stopBeforeFlip)) {
    throw new Error("migration_lab_owner_readonly_run_only");
  }
  const sourceConnection = labLegacySourceConnection(sourceUrl, process.env.MDBASE_CONNECT_ENVIRONMENT, ownerReadonlyRole);
  const db = await createDatabase(process.env.DATABASE_URL);
  const source = await openDatabase(sourceConnection.url, sourceConnection.ssl);
  try {
    const connect = postgresLabConnect({ db, source, actor, timers: true, provider: new HostedProviderClient(providerConfig) });
    if (command === "status") { console.log(JSON.stringify(await labStatus(account.toLowerCase(), { worker, connect }))); return; }
    const deps = { worker, connect, log: (event: Record<string, unknown>) => console.log(JSON.stringify(captureLabWorkerError(event,
      process.env.MDBASE_CONNECT_ENVIRONMENT, process.env.MDBASE_LAB_MIGRATION_RAW_ERROR_FILE))) };
    const outcome: LabOutcome = command === "lab-run"
      ? await labRun(account.toLowerCase(), hold!.toLowerCase(), deps, stopBeforeFlip)
      : command === "resume" ? await resumeLab(account.toLowerCase(), deps)
      : await routeBack(account.toLowerCase(), deps);
    console.log(JSON.stringify(sanitizedLabOutcome(outcome)));
    if ("stopped" in outcome) {
      const { step, reason, inspect, resume } = outcome.stopped;
      console.error(`STOPPED at ${step}: ${reason}\n  inspect: ${inspect}\n  resume:  ${resume}`);
      process.exitCode = 2;
    }
  } finally {
    await source.end();
    await db.end();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  // Refusals print their code; configuration errors print only this module's own text.
  console.error(typeof code === "string" && /^[a-z][a-z0-9_:.-]{0,120}$/u.test(code) ? JSON.stringify({ error: code })
    : error instanceof Error && !(error as { code?: unknown }).code ? error.message : "next-migration-lab failed");
  process.exitCode = 1;
});
