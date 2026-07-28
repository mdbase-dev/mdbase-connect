import {
  InvitationDeliveryError,
  runAuthAdminCommand
} from "./auth-admin.js";
import { createDatabase } from "./db.js";
import { ResendEmailTransport } from "./email.js";
import type { RegistrationMode } from "./runtime-config.js";

const db = await createDatabase();
try {
  const emailTransport = resendTransport(process.env);
  const result = await runAuthAdminCommand(process.argv.slice(2), {
    db,
    defaultRegistrationMode: registrationMode(
      process.env.MDBASE_CONNECT_REGISTRATION
    ),
    ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
    ...(emailTransport ? { emailTransport } : {})
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (error instanceof InvitationDeliveryError) {
    process.stdout.write(`${JSON.stringify(error.output, null, 2)}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
} finally {
  await db.end();
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
