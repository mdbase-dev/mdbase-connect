import { describe, expect, it } from "vitest";
import { schemaDateFormat, schemaDateInputType, schemaDateInputValue, schemaDateValue } from "./schema-date";

describe("schema date fields", () => {
  it("recognizes JSON Schema date formats", () => {
    expect(schemaDateFormat({ type: "string", format: "date" })).toBe("date");
    expect(schemaDateFormat({ type: "string", format: "date-time" })).toBe("date-time");
    expect(schemaDateFormat({ type: "string", format: "time" })).toBeUndefined();
    expect(schemaDateInputType("date")).toBe("date");
    expect(schemaDateInputType("date-time")).toBe("datetime-local");
  });

  it("keeps dates timezone-free", () => {
    expect(schemaDateInputValue("2026-07-21", "date")).toBe("2026-07-21");
    expect(schemaDateValue("2026-07-22", "date")).toBe("2026-07-22");
  });

  it("presents timestamps locally and persists RFC 3339 values", () => {
    const stored = "2026-07-21T05:15:30.000Z";
    const date = new Date(stored);
    const expectedLocal = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    expect(schemaDateInputValue(stored, "date-time")).toBe(expectedLocal);
    expect(schemaDateValue(expectedLocal, "date-time")).toBe(new Date(expectedLocal).toISOString());
    expect(schemaDateInputValue("not a date", "date-time")).toBe("");
  });
});
