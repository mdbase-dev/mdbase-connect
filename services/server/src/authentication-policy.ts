import type {
  DatabasePool,
  DatabaseQueryable
} from "./db.js";
import type { RegistrationMode } from "./runtime-config.js";

export interface AuthenticationSettings {
  registrationMode: RegistrationMode;
  passwordAuthEnabled: boolean;
  emailDeliveryEnabled: boolean;
  termsVersion: string | null;
  privacyVersion: string | null;
  revision: number;
  source: "runtime" | "database";
}

export interface AuthenticationSettingsUpdate {
  registrationMode: RegistrationMode;
  passwordAuthEnabled: boolean;
  emailDeliveryEnabled: boolean;
  termsVersion: string | null;
  privacyVersion: string | null;
  expectedRevision: number;
  updatedBy: string;
  reason: string;
}

interface AuthenticationSettingsRow {
  registration_mode: RegistrationMode;
  password_auth_enabled: boolean;
  email_delivery_enabled: boolean;
  terms_version: string | null;
  privacy_version: string | null;
  revision: string | number;
}

export class AuthenticationSettingsConflictError extends Error {
  constructor() {
    super("Authentication settings changed before this update was applied.");
    this.name = "AuthenticationSettingsConflictError";
  }
}

export class AuthenticationPolicyStore {
  constructor(
    private readonly db: DatabasePool,
    private readonly defaultRegistrationMode: RegistrationMode
  ) {}

  async current(): Promise<AuthenticationSettings> {
    return readAuthenticationSettings(this.db, this.defaultRegistrationMode);
  }

  async currentForAccountChange(
    db: DatabaseQueryable
  ): Promise<AuthenticationSettings> {
    return readAuthenticationSettings(db, this.defaultRegistrationMode, true);
  }

  async update(input: AuthenticationSettingsUpdate): Promise<AuthenticationSettings> {
    validateSettingsUpdate(input);
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const values = [
        input.registrationMode,
        input.passwordAuthEnabled,
        input.emailDeliveryEnabled,
        input.termsVersion?.trim() ?? null,
        input.privacyVersion?.trim() ?? null,
        input.updatedBy.trim(),
        input.reason.trim(),
        input.expectedRevision
      ];
      let result = await connection.query<AuthenticationSettingsRow>(
        `UPDATE authentication_settings SET
           registration_mode = $1,
           password_auth_enabled = $2,
           email_delivery_enabled = $3,
           terms_version = $4,
           privacy_version = $5,
           revision = revision + 1,
           updated_by = $6,
           update_reason = $7,
           updated_at = now()
         WHERE singleton = true AND revision = $8
         RETURNING registration_mode, password_auth_enabled,
                   email_delivery_enabled, terms_version, privacy_version,
                   revision`,
        values
      );
      if (!result.rows[0] && input.expectedRevision === 0) {
        result = await connection.query<AuthenticationSettingsRow>(
          `INSERT INTO authentication_settings
             (singleton, registration_mode, password_auth_enabled,
              email_delivery_enabled, terms_version, privacy_version, revision,
              updated_by, update_reason, updated_at)
           VALUES (true, $1, $2, $3, $4, $5, 1, $6, $7, now())
           ON CONFLICT(singleton) DO NOTHING
           RETURNING registration_mode, password_auth_enabled,
                     email_delivery_enabled, terms_version, privacy_version,
                     revision`,
          values.slice(0, 7)
        );
      }
      const row = result.rows[0];
      const revision = row ? Number(row.revision) : Number.NaN;
      if (!row || revision !== input.expectedRevision + 1) {
        await connection.query("ROLLBACK");
        throw new AuthenticationSettingsConflictError();
      }
      const existingHistory = await connection.query(
        "SELECT revision FROM authentication_settings_history WHERE revision = $1",
        [revision]
      );
      if (existingHistory.rows[0]) {
        await connection.query("ROLLBACK");
        throw new AuthenticationSettingsConflictError();
      }
      await connection.query(
        `INSERT INTO authentication_settings_history
           (revision, registration_mode, password_auth_enabled,
            email_delivery_enabled, terms_version, privacy_version,
            updated_by, update_reason, updated_at)
         SELECT revision, registration_mode, password_auth_enabled,
                email_delivery_enabled, terms_version, privacy_version,
                updated_by, update_reason, updated_at
         FROM authentication_settings WHERE singleton = true`,
      );
      await connection.query("COMMIT");
      return settingsFromRow(row);
    } catch (error) {
      if (!(error instanceof AuthenticationSettingsConflictError)) {
        await connection.query("ROLLBACK");
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

export async function readAuthenticationSettings(
  db: DatabaseQueryable,
  defaultRegistrationMode: RegistrationMode,
  lock = false
): Promise<AuthenticationSettings> {
  const result = await db.query<AuthenticationSettingsRow>(
    `SELECT registration_mode, password_auth_enabled, email_delivery_enabled,
            terms_version, privacy_version, revision
     FROM authentication_settings WHERE singleton = true${lock ? " FOR SHARE" : ""}`
  );
  return result.rows[0]
    ? settingsFromRow(result.rows[0])
    : {
        registrationMode: defaultRegistrationMode,
        passwordAuthEnabled: false,
        emailDeliveryEnabled: false,
        termsVersion: null,
        privacyVersion: null,
        revision: 0,
        source: "runtime"
      };
}

function settingsFromRow(row: AuthenticationSettingsRow): AuthenticationSettings {
  return {
    registrationMode: row.registration_mode,
    passwordAuthEnabled: row.password_auth_enabled,
    emailDeliveryEnabled: row.email_delivery_enabled,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    revision: Number(row.revision),
    source: "database"
  };
}

function validateSettingsUpdate(input: AuthenticationSettingsUpdate): void {
  if (!["closed", "invite", "open"].includes(input.registrationMode)) {
    throw new TypeError("Authentication registration mode is invalid.");
  }
  if (
    typeof input.passwordAuthEnabled !== "boolean"
    || typeof input.emailDeliveryEnabled !== "boolean"
  ) {
    throw new TypeError("Authentication feature controls must be boolean.");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError("Expected authentication settings revision must be a non-negative integer.");
  }
  if (!input.updatedBy.trim() || input.updatedBy.trim().length > 200) {
    throw new TypeError("Authentication settings updates require a valid actor.");
  }
  if (!input.reason.trim() || input.reason.trim().length > 500) {
    throw new TypeError("Authentication settings updates require a concise reason.");
  }
  for (const [name, value] of [
    ["terms", input.termsVersion],
    ["privacy", input.privacyVersion]
  ] as const) {
    if (value !== null && (!value.trim() || value.trim().length > 100)) {
      throw new TypeError(`${name} version must be null or a non-empty version identifier.`);
    }
  }
}
