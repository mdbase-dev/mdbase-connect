# Design System

## Direction

mdbase connect is a desktop utility used in ordinary daylight at a personal
computer while the user is making a consequential access decision. The theme is
minimal, precise, and almost entirely white. Portal and desktop share a compact
product header, visual tokens, and core controls. Desktop views sit in a quiet
horizontal tab row below that header; the compact portal overview needs no
section navigation. Content remains an uninterrupted white canvas. Hierarchy
comes from typography, spacing, and alignment rather than tinted surfaces,
boxes, or decoration.

## Color

- Ink: `oklch(21% 0.018 255)`
- Accent: `oklch(45% 0.105 238)`
- Accent dark: `oklch(35% 0.09 238)`
- Paper: `oklch(99.5% 0.002 255)`
- Hover: `oklch(98% 0.003 255)`
- Line: `oklch(92% 0.006 255)`
- Strong line: `oklch(82% 0.008 255)`
- Connected green: `oklch(43% 0.09 153)`
- Warning amber: `oklch(60% 0.09 75)`
- Danger red: `oklch(50% 0.11 28)`
- Muted text: `oklch(54% 0.014 255)`

Use a light monochrome strategy. Paper is the only major surface. Controls stay
on paper and use fine grey outlines rather than dark fills. Green indicates verified
connection or completion. Amber indicates pending attention. Red indicates
revocation, disconnection, or destructive local administration. Semantic color
should occupy as little space as possible.

## Typography

- Primary family: Atkinson Hyperlegible, matching mdbase.dev and packaged with
  both the desktop app and portal.
- Technical data: Azeret Mono for origins, paths, versions, IDs, operation
  names, and the mdbase wordmark.
- Product headings use compact fixed sizes and strong weight contrast.
- Body copy is 12 to 14px at 1.45 to 1.55 line height, capped near 70ch.

The product name is always written as `mdbase connect`. The wordmark pairs a
small blue dot with lowercase `mdbase`; `connect` remains a quiet secondary
label.

## Layout

- Portal and desktop share a full-width product header with identity or
  connection state aligned opposite the wordmark.
- Desktop primary navigation uses a single horizontal tab row. Counts appear
  only when they clarify local collection state or pending action.
- The portal keeps requests, computers, and service details in one centered
  overview. It does not add navigation when the complete page is already visible.
- Configuration rows are preferred over card grids. Pending access decisions
  use ruled rows. Empty states are plain text with a single next action.
- Whitespace establishes section rhythm. Fine dividers are limited to dense
  lists and places where rows would otherwise become ambiguous.

## Components

- Buttons: 4px radius, 34 to 36px height. Primary and secondary actions remain
  white with different grey border emphasis; quiet and danger actions are text
  led. No dark fills or shadows. All include hover, focus, disabled, and busy
  states.
- Status: pair a colored dot with a text label. Never show a dot alone.
- Permission scopes: plain checkboxes with concrete action descriptions.
- Lists: stable four-column rhythm for identity, target, state, and actions.
- Empty states teach the first useful action without decorative illustration.
- Dialogs are limited to creating collections and confirming high-impact
  actions; routine configuration uses inline panels.

## Motion

Use 150 to 200ms ease-out transitions for hover, navigation, and inline reveals.
Do not animate layout or orchestrate page entry. Disable nonessential motion
under `prefers-reduced-motion`.
