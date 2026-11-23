import type { JSX, ReactNode } from "react";

const dot = (cx: number, cy: number, r = 0.75): JSX.Element => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

/** The small line drawings the record controls share, on a 16 unit grid. */
const glyphs = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  down: <path d="m4 6 4 4 4-4" />,
  up: <path d="m4 10 4-4 4 4" />,
  left: <path d="M10 4 6 8l4 4" />,
  right: <path d="m6 4 4 4-4 4" />,
  filter: <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />,
  search: <><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></>,
  group: <><rect x="2" y="6.25" width="3.5" height="3.5" rx="0.75" /><rect x="10.5" y="2.75" width="3.5" height="3.5" rx="0.75" /><rect x="10.5" y="9.75" width="3.5" height="3.5" rx="0.75" /><path d="M5.5 8H8M8 4.5v7M8 4.5h2.5M8 11.5h2.5" /></>,
  swap: <path d="M2.5 5.5h11M11 3l2.5 2.5L11 8M13.5 10.5h-11M5 8l-2.5 2.5L5 13" />,
  convert: <path d="m3 13 6.5-6.5M11.5 2.5v3M10 4h3M12.5 9v2M11.5 10h2M5 3v2M4 4h2" />,
  remove: <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.75 7v3.5M9.25 7v3.5" />,
  enter: <path d="M12.5 3.5V9H4M6.5 6.5 4 9l2.5 2.5" />,
  text: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  number: <path d="m6.5 2.5-1.5 11M11 2.5l-1.5 11M3 6h10.5M2.5 10H13" />,
  date: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></>,
  boolean: <><rect x="1.5" y="4.5" width="13" height="7" rx="3.5" /><circle cx="5.25" cy="8" r="1.5" /></>,
  choice: <><path d="M2.5 8.2V3.5a1 1 0 0 1 1-1h4.7l5.3 5.3a1 1 0 0 1 0 1.4l-4.3 4.3a1 1 0 0 1-1.4 0z" />{dot(5.5, 5.5)}</>,
  list: <><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" />{dot(3, 4.5)}{dot(3, 8)}{dot(3, 11.5)}</>,
  link: <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.75.75M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.75-.75" />,
  formula: <path d="M11 3.2c-1.6-.6-2.7.1-3 1.8L6.7 12c-.3 1.5-1.3 2-2.5 1.5M5 7h5" />,
} as const satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof glyphs;

export function Glyph({ name, size = 14 }: { readonly name: GlyphName; readonly size?: number }): JSX.Element {
  return (
    <svg className="mdbase-glyph" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {glyphs[name]}
    </svg>
  );
}
