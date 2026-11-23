/** The names of the days nearest today, as they can be typed into a date field. */
export interface DayWords {
  readonly today: string;
  readonly tomorrow: string;
  readonly yesterday: string;
}

export const DAY = 86_400_000;
const iso = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A calendar day as a number of days, free of time zones: midnight UTC of that day. */
export const stamp = (year: number, month: number, day: number): number => Date.UTC(year, month, day);

/** `2026-11-28` as a day, or null when it is not a real date. */
export function parseDay(text: string): number | null {
  const match = iso.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = stamp(year, month - 1, day);
  const date = new Date(at);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? at : null;
}

export function dayText(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Today, where the person is. */
export function todayStamp(now: Date = new Date()): number {
  return stamp(now.getFullYear(), now.getMonth(), now.getDate());
}

export const weekdayNames = (locale: string | undefined, width: "long" | "short" | "narrow"): string[] => {
  const format = new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" });
  // 2024-01-07 was a Sunday.
  return Array.from({ length: 7 }, (_unused, index) => format.format(stamp(2024, 0, 7 + index)));
};

/** Text as it is compared: a typed apostrophe is the one a catalogue writes (`aujourd’hui`). */
const plain = (text: string): string => text.trim().toLowerCase().replaceAll("’", "'");

/**
 * What someone typed as a day: a date as it is stored (`2026-11-28`), one of the day's names
 * (today, tomorrow, yesterday), a weekday (the next one), or a number of days or weeks from
 * today (`+3`, `-1`, `2w`). Null when it is none of those.
 */
export function readDay(text: string, words: DayWords, now: Date = new Date(), locale?: string): number | null {
  const typed = plain(text);
  if (!typed) return null;
  const exact = parseDay(typed);
  if (exact !== null) return exact;
  const today = todayStamp(now);
  const named: [string, number][] = [
    [words.today, 0],
    [words.tomorrow, 1],
    [words.yesterday, -1],
  ];
  for (const [word, offset] of named) {
    if (plain(word) === typed) return today + offset * DAY;
  }
  const relative = /^([+-]?)(\d{1,4})\s*([dw]?)$/u.exec(typed);
  if (relative && (relative[1] || relative[3])) {
    const days = Number(relative[2]) * (relative[3] === "w" ? 7 : 1);
    return today + (relative[1] === "-" ? -days : days) * DAY;
  }
  if (typed.length >= 2) {
    const long = weekdayNames(locale, "long").map((name) => name.toLowerCase());
    const index = long.findIndex((name) => name.startsWith(typed));
    if (index >= 0) {
      const ahead = (index - new Date(today).getUTCDay() + 7) % 7 || 7;
      return today + ahead * DAY;
    }
  }
  return null;
}

/** A day as people read it: `28 Nov 2026`, without the year when it is this one and `short` is set. */
export function formatDay(value: string, options: { short?: boolean; now?: Date; locale?: string } = {}): string {
  const at = parseDay(value);
  if (at === null) return value;
  const sameYear = new Date(at).getUTCFullYear() === (options.now ?? new Date()).getFullYear();
  return new Intl.DateTimeFormat(options.locale, { day: "numeric", month: "short", ...(options.short && sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(at);
}

/** The first day of the week where the person is: 0 for Sunday. Monday where the browser cannot say. */
export function weekStart(locale: string | undefined): number {
  try {
    const info = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    return typeof first === "number" ? first % 7 : 1;
  } catch {
    return 1;
  }
}

/** The six weeks a month is shown in, starting on the week's first day. */
export function monthGrid(year: number, month: number, firstDay: number): number[][] {
  const first = stamp(year, month, 1);
  const lead = (new Date(first).getUTCDay() - firstDay + 7) % 7;
  const start = first - lead * DAY;
  return Array.from({ length: 6 }, (_week, week) => Array.from({ length: 7 }, (_day, day) => start + (week * 7 + day) * DAY));
}
