import {
  InvitationDeliveryError,
  runAuthAdminCommand
} from "./auth-admin.js";
import { openDatabase } from "./db.js";
import { assertControlPlaneMigrationsCurrent } from "./migrations.js";
import { ResendEmailTransport } from "./email.js";
import {
  HostedProviderClient,
  HostedProviderResponseError
} from "./hosted-provider.js";
import {
  hostedProviderConfigFromEnv,
  type RegistrationMode
} from "./runtime-config.js";

const db = await openDatabase();
const requestEnvelope = process.argv[2] === "request";
try {
  await assertControlPlaneMigrationsCurrent(db);
  const emailTransport = resendTransport(process.env);
  const hostedProviderConfig = hostedProviderConfigFromEnv(process.env);
  const hostedProvider = hostedProviderConfig
    ? new HostedProviderClient(hostedProviderConfig)
    : null;
  const result = await runAuthAdminCommand(process.argv.slice(2), {
    db,
    defaultRegistrationMode: registrationMode(
      process.env.MDBASE_CONNECT_REGISTRATION
    ),
    ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
    ...(emailTransport ? { emailTransport } : {}),
    ...(hostedProvider
      ? {
          hostedProvider,
          hostedReplicaRevoker: {
            async revokeReplica(replicaId: string) {
              try {
                await hostedProvider.revokeReplica(replicaId);
              } catch (error) {
                if (
                  error instanceof HostedProviderResponseError
                  && error.status === 404
                ) {
                  return;
                }
                throw error;
              }
            },
            async abortAuthorityImport(transferId: string) {
              try {
                await hostedProvider.abortAuthorityImport(transferId);
              } catch (error) {
                if (
                  error instanceof HostedProviderResponseError
                  && [
                    "authority_import_not_found",
                    "authority_import_inactive"
                  ].includes(error.code)
                ) {
                  return;
                }
                throw error;
              }
            }
          }
        }
      : {})
  });
  writeResult(result);
} catch (error) {
  if (error instanceof InvitationDeliveryError) {
    writeResult(error.output);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (requestEnvelope) {
      process.stdout.write(
        `MDBASE_ADMIN_ERROR:${JSON.stringify({ message })}\n`
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
} finally {
  await db.end();
}

function writeResult(result: unknown): void {
  process.stdout.write(
    requestEnvelope
      ? `MDBASE_ADMIN_RESULT:${JSON.stringify(result)}\n`
      : `${JSON.stringify(result, null, 2)}\n`
  );
}

function resendTransport(
  env: NodeJS.ProcessEnv
): ResendEmailTransport | null {
  const apiKey = env.MDBASE_CONNECT_RESEND_API_KEY?.trim() ?? "";
  const from = env.MDBASE_CONNECT_EMAIL_FROM?.trim() ?? "";
  if (Boolean(apiKey) !== Boolean(from)) {
    throw new Error(
      "MDBASE_CONNECT_RESEND_API_KEY and MDBASE_CONNECT_EMAIL_FROM must be configured together."
    );
  }
  return apiKey && from
    ? new ResendEmailTransport({ apiKey, from })
    : null;
}

function registrationMode(value: string | undefined): RegistrationMode {
  const normalized = value?.trim() || "closed";
  if (
    normalized !== "closed"
    && normalized !== "invite"
    && normalized !== "open"
  ) {
    throw new Error(
      "MDBASE_CONNECT_REGISTRATION must be closed, invite, or open."
    );
  }
  return normalized;
}
