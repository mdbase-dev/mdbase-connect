# Design System

## Direction

mdbase connect is a desktop utility used at a personal computer while the user
is making a consequential access decision. The theme is minimal and precise in
both ordinary daylight and a dim room. Light mode is paper-like; dark mode uses
deep blue-black surfaces without turning the product into terminal cosplay.
Editor, Connect workspace, portal, desktop, Reader and Writer share visual
tokens through `@mdbase-dev/ui`; Editor, Connect workspace, portal, and desktop
also share core controls. The editor keeps one persistent collection rail: All notes, Types,
Settings, then Connect under a quiet Manage heading. Selecting Connect replaces
the note list with contextual Connect navigation; it does not open a parallel
product shell. Transactional portal pages
and desktop views retain their compact product header. Content remains an
uninterrupted canvas. Hierarchy comes from typography, spacing, and alignment
rather than tinted boxes or decoration.

## Color

Role values for light, dark and system themes live in
`packages/app-ui/css/tokens.css`, published as `@mdbase-dev/ui/tokens.css`.
Editor's quiet treatment is the canonical palette; do not restate values here.

Use a restrained monochrome strategy in both themes. The canvas is the only
major surface. Fields use fine neutral outlines; secondary actions use a quiet tonal fill,
tertiary actions read as text, and the single committing action uses a filled
accent. Identity provider buttons retain their required provider treatment, at
secondary weight. Green indicates verified connection or
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

- Primary family: locally packaged Atkinson Hyperlegible Next Variable (200–800).
  Use shared weight tokens: regular 400, medium 500, semibold 600, bold 700.
- Azeret Mono is reserved for paths, source/code and the canonical mdbase wordmark.
  Counts, dates, sizes and versions use the primary family with tabular numerals.
- The six shared size tokens are caption 12px, UI 13px, section 15px, prose 17px,
  heading 24px and document title 34px. UI chrome defaults to 13px; nothing is
  smaller than 12px. Emphasis normally uses 500/600, not bold-or-nothing.
- Account authentication uses the prose token in a centered, mobile-safe column;
  Connect management uses the section token for body copy.
- Labels use sentence case without uppercase tracking. Body copy has a relaxed
  line height and a readable measure, capped near 70ch.
- Typography, the 4/8/12px corner scale, two elevations, spacing and motion come
  from `packages/app-ui/css/tokens.css`, never local raw style values.

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

- The editor's collection rail switches between All notes, Types, Settings, and
  Connect. The Connect sidebar separates current-collection controls (Overview,
  Storage & sync, App access) from account controls (All collections,
  Applications, Computers, Account & sessions).
- Direct Connect entry restores the last valid collection, opens the only
  collection when there is one, and otherwise starts at All collections. A
  collection is never chosen silently from an ambiguous list.
- Desktop primary navigation uses a single horizontal tab row. Counts appear
  only when they clarify local collection state or pending action.
- Portal pages contain one consequential transaction only: authentication,
  pairing, recovery, or authorization approval. They do not duplicate account
  administration.
- Collection metadata editing expands inline beneath the collection row. Name
  and description remain visibly tied to `mdbase.yaml`; availability is a
  separate immediate control.
- Configuration rows are preferred over card grids. Pending access decisions
  use ruled rows. Empty states are plain text with a single next action.
- Whitespace establishes section rhythm. Fine dividers are limited to dense
  lists and places where rows would otherwise become ambiguous.

## Components

- Buttons share `.mdbase-button`: filled accent `.is-primary` for the one
  committing action, a tonal default for secondary actions, and text-led
  `.is-tertiary` for quiet actions. `.is-danger` supplies destructive intent.
  Dense views use 34 to 36px height; transactional pages use 44px. Disabled
  buttons lose the accent, retain readable text, and cannot be mistaken for an
  enabled primary. All actions have hover, visible keyboard focus and busy states.
- Switches use `.mdbase-switch` on a native button with `role="switch"` and
  `aria-checked`; the filled track and moving thumb both distinguish On from Off.
- Checkboxes use `.mdbase-checkbox` on native inputs (or Markdown's existing
  checkbox-role button), with an explicit check mark, indeterminate state,
  visible focus and disabled styling. Labels and Space activation remain native.
  Switches and checkboxes preserve forced-color cues and expand touch hit areas.
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

Use shared duration tokens (120/150/180/240ms) and shared easing for hover,
navigation and inline reveals. Do not orchestrate page entry or introduce
layout animation as decoration. Duration tokens collapse under
`prefers-reduced-motion`; nonessential looping animations are disabled.
