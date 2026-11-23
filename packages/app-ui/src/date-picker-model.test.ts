import { describe, expect, it } from "vitest";

import { dayText, formatDay, monthGrid, parseDay, readDay } from "./date-picker-model.js";

const labels = { today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday" };
/** A Thursday. */
const now = new Date(2026, 10, 12, 9, 30);
const read = (text: string): string | null => {
  const at = readDay(text, labels, now, "en-US");
  return at === null ? null : dayText(at);
};

describe("parseDay", () => {
  it("reads a stored date and refuses one that is not a day", () => {
    expect(dayText(parseDay("2026-11-28")!)).toBe("2026-11-28");
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("28/11/2026")).toBeNull();
    expect(parseDay("2026-11-28T10:00")).toBeNull();
  });
});

describe("readDay", () => {
  it("takes a date as it is stored", () => {
    expect(read(" 2026-12-01 ")).toBe("2026-12-01");
  });
  it("knows the days by name", () => {
    expect(read("today")).toBe("2026-11-12");
    expect(read("Tomorrow")).toBe("2026-11-13");
    expect(read("yesterday")).toBe("2026-11-11");
  });
  it("takes a typed apostrophe for the one the word is written with", () => {
    const at = readDay("aujourd'hui", { today: "Aujourd’hui", tomorrow: "Demain", yesterday: "Hier" }, now, "fr");
    expect(dayText(at!)).toBe("2026-11-12");
  });
  it("counts days and weeks from today", () => {
    expect(read("+3")).toBe("2026-11-15");
    expect(read("-1")).toBe("2026-11-11");
    expect(read("2w")).toBe("2026-11-26");
    expect(read("10d")).toBe("2026-11-22");
  });
  it("takes a weekday as the next one, never today", () => {
    expect(read("fri")).toBe("2026-11-13");
    expect(read("monday")).toBe("2026-11-16");
    expect(read("thu")).toBe("2026-11-19");
  });
  it("does not guess at anything else", () => {
    expect(read("")).toBeNull();
    expect(read("12")).toBeNull();
    expect(read("soon")).toBeNull();
    expect(read("t")).toBeNull();
  });
});

describe("formatDay", () => {
  it("writes a day as people read it, and leaves other text alone", () => {
    expect(formatDay("2026-11-28", { locale: "en-GB", now })).toBe("28 Nov 2026");
    expect(formatDay("2026-11-28", { locale: "en-GB", now, short: true })).toBe("28 Nov");
    expect(formatDay("2027-01-02", { locale: "en-GB", now, short: true })).toBe("2 Jan 2027");
    expect(formatDay("next week")).toBe("next week");
  });
});

describe("monthGrid", () => {
  it("lays a month out in six weeks from the week's first day", () => {
    const monday = monthGrid(2026, 10, 1);
    expect(monday).toHaveLength(6);
    expect(monday.every((week) => week.length === 7)).toBe(true);
    // November 2026 starts on a Sunday: with weeks from Monday, the first row is mostly October.
    expect(dayText(monday[0]![0]!)).toBe("2026-10-26");
    expect(dayText(monday[0]![6]!)).toBe("2026-11-01");
    const sunday = monthGrid(2026, 10, 0);
    expect(dayText(sunday[0]![0]!)).toBe("2026-11-01");
    expect(dayText(sunday[5]![6]!)).toBe("2026-12-12");
  });
});
