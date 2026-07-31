# Design System

## Direction

mdbase connect is a desktop utility used at a personal computer while the user
is making a consequential access decision. The theme is minimal and precise in
both ordinary daylight and a dim room. Light mode is paper-like; dark mode uses
deep blue-black surfaces without turning the product into terminal cosplay.
Portal and desktop share a single compact left sidebar, visual tokens, and core
controls. Each navigation item opens one focused page in an uninterrupted
canvas. Hierarchy comes from typography, spacing, and alignment rather than
tinted boxes or decoration.

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

Dark mode uses canvas `oklch(17.5% 0.012 255)`, surface
`oklch(19.5% 0.012 255)`, ink `oklch(92% 0.008 255)`, muted ink
`oklch(68% 0.012 255)`, line `oklch(29% 0.012 255)`, and accent
`oklch(73% 0.105 238)`. Success, warning, and danger colors increase in
lightness for equivalent contrast.

Use a restrained monochrome strategy in both themes. The canvas is the only
major surface. Controls stay on that surface and use fine neutral outlines
rather than contrasting fills. Green indicates verified connection or
completion. Amber indicates pending attention. Red indicates revocation,
disconnection, or destructive local administration. Semantic color should
occupy as little space as possible.

## Theme contract

Every surface offers System, Light, and Dark. System follows
`prefers-color-scheme`; an explicit choice is stored locally as `mdbase:theme`
and applied before first paint. The shared semantic roles are canvas, surface,
surface-subtle, text, text-soft, text-muted, border, border-strong, accent,
success, warning, and danger. Components consume roles rather than palette
values so both themes preserve the same hierarchy.

## Typography

- Primary family: Atkinson Hyperlegible, matching mdbase.dev and packaged with
  both the desktop app and portal.
- Technical data: Azeret Mono for origins, paths, versions, IDs, operation
  names, and the mdbase wordmark.
- Product headings use compact fixed sizes and strong weight contrast.
- Body copy is 12 to 14px at 1.45 to 1.55 line height, capped near 70ch.

The product name is always written as `mdbase connect`. The wordmark pairs a
20px Frontmatter mark with lowercase `mdbase`; `connect` remains a quiet
secondary label. Keep the wordmark as live type.

## Identity

The canonical mark is a square piece of Frontmatter: segmented upper and lower
fences, two key-value rows, and a blue first value. It represents plain-text
structure becoming useful without implying a cloud, folder, or proprietary
database.

The visible geometry is a `76 × 76` square. Every element has the same weight,
every horizontal gap is equal, and every row follows one vertical interval.
The mark identifies mdbase only; it never substitutes for connection,
authorization, or health status.

Use the default, dark-surface, monochrome, favicon, and application-icon assets
in `assets/`. Construction, sizing, lockup, and misuse guidance live in
[`docs/product-design/identity-system.md`](docs/product-design/identity-system.md).
Product application guidance lives in
[`docs/product-design/interface-foundations.md`](docs/product-design/interface-foundations.md)
and interaction guidance in
[`docs/product-design/core-flows.md`](docs/product-design/core-flows.md).

## Layout

- Portal and desktop use the same fixed left-sidebar shell, with identity or
  connection state in its footer and a focused page canvas beside it.
- Counts appear only when they clarify collection state, connected resources,
  or pending action. The current destination uses ordinary page navigation.
- The portal gives requests, hosted collections, application access, computers,
  and account management stable routes. Its overview summarizes those pages
  without duplicating their management controls.
- Collection metadata editing expands inline beneath the collection row. Name
  and description remain visibly tied to `mdbase.yaml`; availability is a
  separate immediate control.
- Configuration rows are preferred over card grids. Pending access decisions
  use ruled rows. Empty states are plain text with a single next action.
- Whitespace establishes section rhythm. Fine dividers are limited to dense
  lists and places where rows would otherwise become ambiguous.

## Components

- Buttons: 4px radius, 34 to 36px height. Primary and secondary actions remain
  on the current surface with different border emphasis; quiet and danger
  actions are text led. No contrasting fills or shadows. All include hover,
  focus, disabled, and busy states.
- Status: pair a colored dot with a text label. Never show a dot alone.
- Direct access: explain the browser's local-network prompt beside one quiet,
  user-initiated action. Afterward, show only `Connected directly` or
  `Connected through mdbase`; do not ask users to choose a transport.
- Permission scopes: plain checkboxes with concrete action descriptions.
- Lists: stable four-column rhythm for identity, target, state, and actions.
- Empty states teach the first useful action without decorative illustration.
- Dialogs are limited to creating collections and confirming high-impact
  actions; routine configuration uses inline panels.

## Motion

Use 150 to 200ms ease-out transitions for hover, navigation, and inline reveals.
Do not animate layout or orchestrate page entry. Disable nonessential motion
under `prefers-reduced-motion`.
