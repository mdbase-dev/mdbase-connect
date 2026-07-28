import { useEffect, useState } from "react";
import {
  api,
  type AccountSession
} from "./api";

export function SessionManager({
  onError
}: {
  onError(value: string): void;
}) {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [busy, setBusy] = useState("");

  async function refresh() {
    try {
      const result = await api<{ sessions: AccountSession[] }>(
        "/v1/account/sessions"
      );
      setSessions(result.sessions);
    } catch (reason) {
      onError(message(reason));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(session: AccountSession) {
    setBusy(session.id);
    try {
      await api(`/v1/account/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE"
      });
      await refresh();
    } catch (reason) {
      onError(message(reason));
    } finally {
      setBusy("");
    }
  }

  async function revokeOthers() {
    setBusy("others");
    try {
      await api("/v1/account/sessions/revoke-others", { method: "POST" });
      await refresh();
    } catch (reason) {
      onError(message(reason));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="session-management">
      <div className="session-subheading">
        <div>
          <h3>Browser sessions</h3>
          <p>Sign out a browser you no longer use.</p>
        </div>
        {sessions && sessions.some((session) => !session.current) && (
          <button
            className="quiet-danger"
            disabled={Boolean(busy)}
            onClick={() => void revokeOthers()}
          >
            {busy === "others" ? "Signing out…" : "Sign out other sessions"}
          </button>
        )}
      </div>
      {!sessions
        ? <p className="session-loading">Checking active sessions…</p>
        : <div className="session-list">{sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <div>
                <strong>{session.client_name}</strong>
                <small>{session.current
                  ? "This browser, active now"
                  : `Last used ${relativeTime(session.last_seen_at)}`}</small>
              </div>
              <span>{authenticationLabel(session.provider)}</span>
              <div>
                {session.current
                  ? <span className="session-current">Current</span>
                  : <button
                      className="quiet-danger"
                      disabled={Boolean(busy)}
                      onClick={() => void revoke(session)}
                    >
                      {busy === session.id ? "Signing out…" : "Sign out"}
                    </button>}
              </div>
            </div>
          ))}</div>}
    </div>
  );
}

function authenticationLabel(provider: AccountSession["provider"]): string {
  if (provider === "google") return "Google";
  if (provider === "github") return "GitHub";
  if (provider === "password") return "Email and password";
  return "Session";
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
