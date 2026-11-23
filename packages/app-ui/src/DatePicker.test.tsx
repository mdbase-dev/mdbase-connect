// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, cleanup, click, find, get, key, mount, type } from "../test/dom.js";
import { accessibleName, visibleLabel } from "../test/label-in-name.js";
import { Calendar, DateField, formatDay, readDay } from "./DatePicker.js";

beforeEach(() => {
  // A Thursday.
  vi.useFakeTimers({ now: new Date(2026, 10, 12, 9, 30), toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("readDay and formatDay", () => {
  it("read a typed day in the words of the interface, and write a stored one as people read it", () => {
    expect(readDay("tomorrow", { locale: "en-GB" })).toBe("2026-11-13");
    expect(readDay("demain", { labels: { today: "aujourd’hui", tomorrow: "demain", yesterday: "hier" }, locale: "fr" })).toBe("2026-11-13");
    expect(readDay("soon")).toBeNull();
    expect(formatDay("2026-11-28", { locale: "en-GB" })).toBe("28 Nov 2026");
    expect(formatDay("2026-11-28", { locale: "en-GB", short: true })).toBe("28 Nov");
  });
});

describe("Calendar", () => {
  it("opens on the chosen day's month and takes the day that is pressed", () => {
    const onPick = vi.fn();
    mount(<Calendar value="2026-12-24" locale="en-GB" onPick={onPick} />);
    expect(get("gridcell", /24 December 2026/u).getAttribute("aria-selected")).toBe("true");
    click(get("gridcell", /25 December 2026/u));
    expect(onPick).toHaveBeenCalledWith("2026-12-25");
  });

  it("marks today and offers it, and tomorrow, by name", () => {
    const onPick = vi.fn();
    mount(<Calendar value={null} locale="en-GB" onPick={onPick} />);
    expect(get("gridcell", /12 November 2026/u).getAttribute("aria-current")).toBe("date");
    click(get("button", "Tomorrow"));
    expect(onPick).toHaveBeenLastCalledWith("2026-11-13");
    click(get("button", "Today"));
    expect(onPick).toHaveBeenLastCalledWith("2026-11-12");
  });

  it("reads what is typed and takes it on Enter, but not text that is no day", () => {
    const onPick = vi.fn();
    const view = mount(<Calendar value={null} locale="en-GB" onPick={onPick} />);
    const field = get("textbox", "A date, “tomorrow”, “fri” or “+3”");
    type(field, "+3");
    expect(view.host.querySelector(".mdbase-calendar-read")!.textContent).toMatch(/^Sunday,? 15 November 2026$/u);
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("2026-11-15");
    type(field, "soon");
    key("Enter");
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("moves through the days and the months from the field", () => {
    const onPick = vi.fn();
    mount(<Calendar value="2026-11-12" locale="en-GB" onPick={onPick} />);
    get("textbox").focus();
    key("ArrowDown");
    key("PageDown");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("2026-12-19");
  });

  it("steps a month at a time, and offers to take the date away when there is one", () => {
    const onClear = vi.fn();
    const view = mount(<Calendar value="2026-11-12" locale="en-GB" onPick={vi.fn()} onClear={onClear} />);
    const title = () => view.host.querySelector(".mdbase-calendar-title")!.textContent;
    expect(title()).toBe("November 2026");
    click(get("button", "Next month"));
    expect(title()).toBe("December 2026");
    click(get("button", "Previous month"));
    click(get("button", "Previous month"));
    expect(title()).toBe("October 2026");
    click(get("button", "Clear"));
    expect(onClear).toHaveBeenCalledOnce();
    view.render(<Calendar value={null} locale="en-GB" onPick={vi.fn()} onClear={onClear} />);
    expect(find("button", "Clear")).toBeNull();
  });

  it("starts the week where the locale does", () => {
    const view = mount(<Calendar value="2026-11-12" locale="en-GB" onPick={vi.fn()} />);
    expect(all("columnheader")[0]!.getAttribute("aria-label")).toBe("Monday");
    view.render(<Calendar value="2026-11-12" locale="en-US" onPick={vi.fn()} />);
    expect(all("columnheader")[0]!.getAttribute("aria-label")).toBe("Sunday");
  });
});

describe("DateField", () => {
  it("names itself with the date it shows, and opens a calendar that changes it", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    mount(<DateField value="2026-11-28" label="due" placeholder="Empty" onChange={onChange} onClose={onClose} />);
    const field = get("button", /^due: /u);
    expect(accessibleName(field)).toContain(visibleLabel(field));
    expect(field.getAttribute("aria-expanded")).toBe("false");
    click(field);
    const calendar = get("dialog", "due");
    expect(document.activeElement).toBe(get("textbox", undefined, calendar));
    click(get("button", "Tomorrow", calendar));
    expect(onChange).toHaveBeenCalledWith("2026-11-13");
    expect(onClose).toHaveBeenCalledOnce();
    expect(find("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("shows its placeholder while there is no date, and closes on Escape without a change", () => {
    const onChange = vi.fn();
    mount(<DateField value="" label="due" placeholder="Empty" defaultOpen onChange={onChange} />);
    expect(get("button", "due: Empty").textContent).toBe("Empty");
    expect(get("dialog", "due")).toBeTruthy();
    key("Escape");
    expect(find("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(get("button", "due: Empty"));
  });

  it("takes the date away", () => {
    const onChange = vi.fn();
    mount(<DateField value="2026-11-28" label="due" placeholder="Empty" defaultOpen onChange={onChange} />);
    click(get("button", "Clear"));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(find("dialog")).toBeNull();
  });
});
