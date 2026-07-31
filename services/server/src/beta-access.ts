import { randomUUID } from "node:crypto";
import type { DatabasePool } from "./database-types.js";
import {
  EMAIL_NORMALIZATION_VERSION,
  normalizeEmailAddress
} from "./email-identity.js";

export class BetaAccessRequestService {
  constructor(private readonly db: DatabasePool) {}

  async request(emailInput: string): Promise<void> {
    const email = emailInput.trim().normalize("NFC");
    const normalizedEmail = normalizeEmailAddress(email);
    await this.db.query(
      `INSERT INTO beta_access_requests
         (id, email, normalized_email, email_normalization_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(normalized_email) DO NOTHING`,
      [randomUUID(), email, normalizedEmail, EMAIL_NORMALIZATION_VERSION]
    );
  }
}
