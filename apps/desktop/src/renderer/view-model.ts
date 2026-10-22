export type Route = "overview" | "collections" | "access" | "activity" | "settings";

export function host(value: string) { try { return new URL(value).host; } catch { return value; } }
export function message(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:(?:Error|AgentControlError|DaemonControlError): )?/, "");
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) {
    return "mdbase connect could not reach the service. Check your connection and try again.";
  }
  if (/pair with an authenticated account|account_identity_missing/i.test(detail)) {
    return "Sign in to mdbase on this computer before adding a collection.";
  }
  if (/unsupported.+protocol|up-to-date connector|no longer compatible/i.test(detail)) {
    return "This version of mdbase connect needs to be updated before it can continue.";
  }
  return detail;
}
export function plural(count: number, singular: string, pluralValue: string) { return count === 1 ? singular : pluralValue; }
export function relativeTime(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
