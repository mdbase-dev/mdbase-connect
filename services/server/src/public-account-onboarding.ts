import type { DatabaseQueryable } from "./database-types.js";
import { scheduleStarterCollection } from "./account-onboarding.js";
import { scheduleOpenBetaWelcomeEmail } from "./beta-welcome-email.js";
import { materializePublicSignupEntitlement } from "./entitlements.js";

/** Runs inside the account-creation transaction for every public signup method. */
export async function completePublicAccountOnboarding(
  db: DatabaseQueryable,
  input: {
    userId: string;
    emailIdentityId: string;
    termsVersion: string;
    privacyVersion: string;
    acceptanceMethod: "email_verification" | "external_identity";
    timezone: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO account_agreements
       (user_id, document, version, acceptance_method)
     VALUES ($1, 'terms', $2, $4), ($1, 'privacy', $3, $4)`,
    [input.userId, input.termsVersion, input.privacyVersion, input.acceptanceMethod]
  );
  await materializePublicSignupEntitlement(db, input.userId);
  await scheduleOpenBetaWelcomeEmail(db, input);
  await scheduleStarterCollection(db, input.userId, input.timezone);
}
