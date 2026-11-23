import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { AnchoredPopover } from "./AnchoredPopover.js";
import { DAY, dayText, formatDay as formatDayIn, monthGrid, parseDay, readDay as readDayIn, stamp, todayStamp, weekdayNames, weekStart, type DayWords } from "./date-picker-model.js";
import { Glyph } from "./glyphs.js";
import { useLocaleRevision } from "./i18n.js";

export { dayText, parseDay } from "./date-picker-model.js";

/** The date picker's own text. */
export interface DateLabels extends DayWords {
  /** The field's placeholder: what can be typed in it. */
  readonly typeDate: string;
  readonly clear: string;
  readonly previousMonth: string;
  readonly nextMonth: string;
  /** The calendar's accessible name. */
  readonly calendar: string;
}

/** The date picker's text in the current language. */
export function dateLabels(): DateLabels {
  return {
    typeDate: t`A date, “tomorrow”, “fri” or “+3”`,
    today: t`Today`,
    tomorrow: t`Tomorrow`,
    yesterday: t`Yesterday`,
    clear: t`Clear`,
    previousMonth: t`Previous month`,
    nextMonth: t`Next month`,
    calendar: t`Calendar`,
  };
}

/**
 * The locale dates are written in: the language of the interface, in the browser's own variant
 * of it when it has one, since that says which day starts the week and how a date is ordered.
 */
function displayLocale(): string {
  const language = i18n.locale || "en";
  const browser = typeof navigator === "undefined" ? undefined : navigator.language;
  if (browser && browser.toLowerCase().split("-")[0] === language) return browser;
  return language === "pt" ? "pt-BR" : language === "zh" ? "zh-CN" : language;
}

/**
 * What someone typed as a day: a date as it is stored (`2026-11-28`), today, tomorrow or
 * yesterday by name, a weekday (the next one), or a number of days or weeks from today (`+3`,
 * `-1`, `2w`). Null when it is none of those.
 */
export function readDay(text: string, options: { readonly labels?: DayWords; readonly now?: Date; readonly locale?: string } = {}): string | null {
  const at = readDayIn(text, options.labels ?? dateLabels(), options.now, options.locale ?? displayLocale());
  return at === null ? null : dayText(at);
}

/** A stored day as people read it: `28 Nov 2026`, without the year when it is this one and `short` is set. Other text is returned as it is. */
export function formatDay(value: string, options: { readonly short?: boolean; readonly now?: Date; readonly locale?: string } = {}): string {
  return formatDayIn(value, { ...options, locale: options.locale ?? displayLocale() });
}

export interface CalendarProps {
  /** The chosen day, as it is stored. */
  value: string | null;
  onPick: (value: string) => void;
  /** Offer to take the date away. */
  onClear?: (() => void) | undefined;
  /** Whether the text field asks for the focus when the calendar appears in a popover. */
  autoFocus?: boolean | undefined;
  /** The locale the month is drawn in. By default, the language of the interface. */
  locale?: string | undefined;
  /** Text to show in place of the shared catalogue's. */
  labels?: Partial<DateLabels> | undefined;
}

/**
 * A month to pick a day from, under a field that takes a typed one. The arrow keys move through
 * the days from either the field or the grid; Enter takes the day they are on.
 */
export function Calendar(props: CalendarProps): JSX.Element {
  useLocaleRevision();
  const labels: DateLabels = { ...dateLabels(), ...props.labels };
  const locale = props.locale ?? displayLocale();
  const chosen = props.value ? parseDay(props.value) : null;
  const today = todayStamp();
  const [cursor, setCursor] = useState(chosen ?? today);
  const [text, setText] = useState("");
  const grid = useRef<HTMLDivElement>(null);
  const firstDay = useMemo(() => weekStart(locale), [locale]);
  const names = useMemo(() => ({ narrow: weekdayNames(locale, "narrow"), long: weekdayNames(locale, "long") }), [locale]);
  const at = new Date(cursor);
  const [year, month] = [at.getUTCFullYear(), at.getUTCMonth()];
  const weeks = useMemo(() => monthGrid(year, month, firstDay), [year, month, firstDay]);
  const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(stamp(year, month, 1));
  const full = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }), [locale]);
  const typed = readDayIn(text, labels, new Date(), locale);

  const shiftMonth = (by: number): void => {
    const target = new Date(stamp(year, month + by, 1));
    const last = new Date(stamp(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    setCursor(stamp(target.getUTCFullYear(), target.getUTCMonth(), Math.min(at.getUTCDate(), last)));
  };
  const move = (event: KeyboardEvent, inGrid: boolean): boolean => {
    const steps: Record<string, number> = { ArrowUp: -7, ArrowDown: 7, ...(inGrid ? { ArrowLeft: -1, ArrowRight: 1 } : {}) };
    const step = steps[event.key];
    if (step !== undefined) {
      setCursor(cursor + step * DAY);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      shiftMonth((event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
    } else if (inGrid && (event.key === "Home" || event.key === "End")) {
      const column = (at.getUTCDay() - firstDay + 7) % 7;
      setCursor(cursor + (event.key === "Home" ? -column : 6 - column) * DAY);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  };

  return (
    <div className="mdbase-calendar">
      <input
        className="mdbase-field mdbase-calendar-input"
        data-autofocus={props.autoFocus === false ? undefined : ""}
        value={text}
        placeholder={labels.typeDate}
        aria-label={labels.typeDate}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setText(event.target.value);
          const found = readDayIn(event.target.value, labels, new Date(), locale);
          if (found !== null) setCursor(found);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            // Something typed that is not a date is not a reason to take the day shown.
            if (!text.trim() || typed !== null) props.onPick(dayText(typed ?? cursor));
          } else if (move(event, false)) {
            event.stopPropagation();
          }
        }}
      />
      {text.trim() ? (
        <p className="mdbase-calendar-read" data-unread={typed === null ? "" : undefined} aria-live="polite">
          {typed === null ? "—" : full.format(typed)}
        </p>
      ) : null}
      <div className="mdbase-calendar-head">
        <span className="mdbase-calendar-title" aria-live="polite">
          {title}
        </span>
        <button type="button" className="mdbase-calendar-step" aria-label={labels.previousMonth} title={labels.previousMonth} onClick={() => shiftMonth(-1)}>
          <Glyph name="left" />
        </button>
        <button type="button" className="mdbase-calendar-step" aria-label={labels.nextMonth} title={labels.nextMonth} onClick={() => shiftMonth(1)}>
          <Glyph name="right" />
        </button>
      </div>
      <div
        ref={grid}
        className="mdbase-calendar-grid"
        role="grid"
        aria-label={labels.calendar}
        onKeyDown={(event) => {
          if (move(event, true)) {
            event.stopPropagation();
            // The day the keys land on takes the focus once it is drawn.
            requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true }));
          }
        }}
      >
        <div className="mdbase-calendar-week" role="row">
          {Array.from({ length: 7 }, (_unused, index) => (
            <span key={index} role="columnheader" aria-label={names.long[(index + firstDay) % 7]}>
              {names.narrow[(index + firstDay) % 7]}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="mdbase-calendar-week" role="row">
            {week.map((day) => (
              <button
                key={day}
                type="button"
                role="gridcell"
                className="mdbase-calendar-day"
                tabIndex={day === cursor ? 0 : -1}
                aria-label={full.format(day)}
                aria-selected={day === chosen}
                aria-current={day === today ? "date" : undefined}
                data-outside={new Date(day).getUTCMonth() === month ? undefined : ""}
                data-cursor={day === cursor ? "" : undefined}
                onClick={() => props.onPick(dayText(day))}
              >
                {new Date(day).getUTCDate()}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="mdbase-calendar-foot">
        <button type="button" className="mdbase-calendar-quick" onClick={() => props.onPick(dayText(today))}>
          {labels.today}
        </button>
        <button type="button" className="mdbase-calendar-quick" onClick={() => props.onPick(dayText(today + DAY))}>
          {labels.tomorrow}
        </button>
        {props.onClear && props.value ? (
          <button type="button" className="mdbase-calendar-quick" data-clear="" onClick={props.onClear}>
            {labels.clear}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface DateFieldProps {
  /** The date as it is stored, or empty. */
  value: string;
  /** Names the field for assistive technology. */
  label: string;
  /** Shown while there is no date. */
  placeholder: string;
  className?: string | undefined;
  /** Open the calendar as soon as the field appears. */
  defaultOpen?: boolean | undefined;
  /** Leave the year out when it is this one: for a card, where room is short. */
  short?: boolean | undefined;
  onChange: (value: string | null) => void;
  /** The calendar was closed, with or without a date chosen. */
  onClose?: (() => void) | undefined;
  /** Text to show in place of the shared catalogue's. */
  labels?: Partial<DateLabels> | undefined;
}

/** A date that reads as a date and opens a calendar to change it. */
export function DateField(props: DateFieldProps): JSX.Element {
  useLocaleRevision();
  const [open, setOpen] = useState(Boolean(props.defaultOpen));
  const anchor = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) anchor.current?.focus({ preventScroll: true });
    props.onClose?.();
  };
  const shown = props.value ? formatDay(props.value, { short: Boolean(props.short) }) : props.placeholder;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={["mdbase-date-field", props.className].filter(Boolean).join(" ")}
        // The name carries the date the button shows, so it can be asked for by what is seen.
        aria-label={`${props.label}: ${shown}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-empty={props.value ? undefined : ""}
        onClick={() => setOpen(!open)}
      >
        {shown}
      </button>
      {open ? (
        <AnchoredPopover anchor={anchor} label={props.label} className="mdbase-date-popover" onClose={close}>
          <Calendar
            value={props.value || null}
            labels={props.labels}
            onPick={(value) => {
              if (value !== props.value) props.onChange(value);
              close(true);
            }}
            onClear={() => {
              props.onChange(null);
              close(true);
            }}
          />
        </AnchoredPopover>
      ) : null}
    </>
  );
}
