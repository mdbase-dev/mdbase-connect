import { randomUUID } from "node:crypto";
import type {
  DatabasePool,
  DatabaseQueryable
} from "./db.js";

const SESSION_CLIENT_NAME_MAX_LENGTH = 100;

export interface AccountSession {
  id: string;
  provider: string;
  clientName: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  current: boolean;
}

interface AccountSessionRow {
  id: string;
  provider: string;
  client_name: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
}

export class AccountSessionService {
  constructor(private readonly db: DatabasePool) {}

  async list(userId: string, currentSessionId: string): Promise<AccountSession[]> {
    const sessions = await this.db.query<AccountSessionRow>(
      `SELECT s.id, s.provider, s.client_name, s.created_at,
              s.last_seen_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.account_session_epoch = u.session_epoch
       ORDER BY s.last_seen_at DESC, s.created_at DESC`,
      [userId]
    );
    return sessions.rows.map((session) => ({
      id: session.id,
      provider: session.provider,
      clientName: session.client_name ?? "Browser session",
      createdAt: new Date(session.created_at),
      lastSeenAt: new Date(session.last_seen_at),
      expiresAt: new Date(session.expires_at),
      current: session.id === currentSessionId
    }));
  }

  async revoke(
    userId: string,
    sessionId: string
  ): Promise<boolean> {
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const revoked = await connection.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE id = $1 AND user_id = $2
           AND revoked_at IS NULL AND expires_at > now()
         RETURNING id`,
        [sessionId, userId]
      );
      if (!revoked.rows[0]) {
        await connection.query("ROLLBACK");
        return false;
      }
      await audit(connection, userId, "session.revoked", sessionId, {
        source: "account"
      });
      await connection.query("COMMIT");
      return true;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeOthers(
    userId: string,
    currentSessionId: string
  ): Promise<number> {
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const revoked = await connection.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND id <> $2
           AND revoked_at IS NULL AND expires_at > now()
         RETURNING id`,
        [userId, currentSessionId]
      );
      await audit(connection, userId, "session.revoked_others", currentSessionId, {
        revoked_count: revoked.rows.length
      });
      await connection.query("COMMIT");
      return revoked.rows.length;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}

export function sessionClientName(userAgent: string | string[] | undefined): string {
  const value = (Array.isArray(userAgent) ? userAgent[0] : userAgent)
    ?.trim()
    .normalize("NFC") ?? "";
  if (!value) return "Browser session";
  const browser = value.includes("Edg/")
    ? "Edge"
    : value.includes("Firefox/")
      ? "Firefox"
      : value.includes("CriOS/")
        ? "Chrome"
        : value.includes("Chrome/")
          ? "Chrome"
          : value.includes("Safari/") && value.includes("Version/")
            ? "Safari"
            : "Browser";
  const platform = /iPad/u.test(value)
    ? "iPad"
    : /iPhone/u.test(value)
      ? "iPhone"
      : /Android/u.test(value)
        ? "Android"
        : /Windows/u.test(value)
          ? "Windows"
          : /Macintosh|Mac OS X/u.test(value)
            ? "macOS"
            : /Linux/u.test(value)
              ? "Linux"
              : "";
  return `${browser}${platform ? ` on ${platform}` : ""}`
    .slice(0, SESSION_CLIENT_NAME_MAX_LENGTH);
}

async function audit(
  db: DatabaseQueryable,
  userId: string,
  eventType: string,
  subjectId: string,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), userId, eventType, subjectId, JSON.stringify(metadata)]
  );
}
