import { t } from "@lingui/core/macro";
import { displayLocale } from "./i18n/format";
import type { NoteVersion } from "./model";

/** One author's saves this close together read as a single edit. */
export const COLLAPSE_MS = 10 * 60_000;

/** One timeline row: an author's run of saves, shown as its newest version. */
export interface HistoryRow {
  /** The newest version in the run: what selecting the row shows. */
  version: NoteVersion;
  /** The oldest save's time, when the row stands for several saves. */
  since?: number;
  /** How many saves the row stands for. */
  saves: number;
}

export interface HistoryDay {
  /** Local calendar date, `YYYY-MM-DD`. */
  key: string;
  rows: HistoryRow[];
}

/** Who wrote a version, for collapsing: the account the write is attributed to,
 * its device and its app. Edits made outside mdbase are one author. */
function authorKey(version: NoteVersion): string {
  if (version.source === "external") return "external";
  const { author } = version;
  return [author.grantAccount ?? author.account, author.device, version.app ?? ""].join("/");
}

function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Group versions (newest first) by local day. Consecutive edits by one author,
 * each within ten minutes of the next, collapse into one row; creations, moves
 * and deletions keep rows of their own. */
export function historyTimeline(versions: readonly NoteVersion[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const version of versions) {
    const key = dayKey(version.time);
    let day = days.at(-1);
    if (day?.key !== key) days.push(day = { key, rows: [] });
    const row = day.rows.at(-1);
    const oldest = row && (row.since ?? row.version.time);
    if (row && version.kind === "edited" && row.version.kind === "edited"
      && authorKey(version) === authorKey(row.version)
      && oldest !== undefined && oldest - version.time <= COLLAPSE_MS) {
      row.since = version.time;
      row.saves += 1;
    } else {
      day.rows.push({ version, saves: 1 });
    }
  }
  return days;
}

/** "Today", "Yesterday", or the date. */
export function dayLabel(key: string, now = new Date()): string {
  if (key === dayKey(now.getTime())) return t`Today`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return t`Yesterday`;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year!, month! - 1, day);
  return new Intl.DateTimeFormat(displayLocale(), {
    weekday: "long", month: "long", day: "numeric",
    ...(year === now.getFullYear() ? {} : { year: "numeric" })
  }).format(date);
}

export function timeLabel(time: number): string {
  return new Intl.DateTimeFormat(displayLocale(), { hour: "numeric", minute: "2-digit" }).format(new Date(time));
}

export function dateLabel(time: number): string {
  return new Intl.DateTimeFormat(displayLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
}

/** The editor's own app ID. */
export const EDITOR_APP_ID = "dev.mdbase.editor";

function appName(app: string): string {
  return app === EDITOR_APP_ID ? "mdbase editor" : app;
}

/** The all-zero account the hosted device signs with. */
const SERVICE_ACCOUNT = "00000000-0000-0000-0000-000000000000";

/**
 * Who made a version, in words. `me` is the signed-in account, when the
 * collection told the editor who that is; without it no version reads as yours
 * or as a collaborator's.
 */
export function versionAuthor(version: NoteVersion, me?: string): string {
  if (version.source === "external") return t`Edited outside mdbase`;
  const account = version.author.grantAccount ?? version.author.account;
  const who = !me || account === SERVICE_ACCOUNT ? "unknown" : account === me ? "you" : "other";
  if (version.app) {
    const app = appName(version.app);
    return who === "you" ? t`You, in ${app}` : who === "other" ? t`A collaborator, in ${app}` : app;
  }
  switch (version.deviceKind) {
    case "desktop": return who === "you" ? t`You, on desktop` : who === "other" ? t`A collaborator, on desktop` : t`On desktop`;
    case "mobile": return who === "you" ? t`You, on mobile` : who === "other" ? t`A collaborator, on mobile` : t`On mobile`;
    case "app_runtime": return who === "you" ? t`You, on the web` : who === "other" ? t`A collaborator, on the web` : t`On the web`;
    case "cli": return who === "you" ? t`You, from the command line` : who === "other" ? t`A collaborator, from the command line` : t`From the command line`;
    default: return who === "you" ? t`You, on another device` : who === "other" ? t`A collaborator` : t`On another device`;
  }
}

/** What a row did, when it did more than edit the text. */
export function versionChange(version: NoteVersion): string | undefined {
  switch (version.kind) {
    case "created": return t`Created`;
    case "moved": return t`Moved to ${version.path}`;
    case "deleted": return t`Deleted`;
    default: return undefined;
  }
}
