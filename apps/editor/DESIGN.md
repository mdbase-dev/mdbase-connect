# Design system

## Direction

A laptop used for long-form writing in daylight or a dim room. Light mode is an
almost-white sheet; dark mode is a low-glare blue-black writing surface. Both
are divided by fine rules into a collection rail, a note list, and a generous
editor. There are no floating cards and almost no chrome.

## Color

- Canvas: `oklch(99.4% 0.003 245)`
- Raised white: `oklch(100% 0.002 245)`
- Ink: `oklch(21% 0.018 255)`
- Muted ink: `oklch(51% 0.014 255)`
- Faint ink: `oklch(52% 0.01 255)`
- Line: `oklch(92.5% 0.006 255)`
- Hover: `oklch(97.7% 0.006 245)`
- Selected: `oklch(96.4% 0.016 238)`
- Accent: `oklch(47% 0.1 238)`
- Danger: `oklch(50% 0.11 28)`

Dark mode uses canvas `oklch(17.5% 0.012 255)`, writing surface
`oklch(19.5% 0.012 255)`, ink `oklch(92% 0.008 255)`, muted ink
`oklch(72% 0.012 255)`, line `oklch(29% 0.012 255)`, and accent
`oklch(73% 0.105 238)`. Syntax, diff, warning, selection, skeleton, and conflict
colors have theme-specific semantic roles.

## Theme contract

The editor offers System, Light, and Dark in Settings. System follows
`prefers-color-scheme`; an explicit choice is stored locally as `mdbase:theme`
and applied before first paint. Components consume canvas, surface,
surface-subtle, text, text-soft, text-muted, border, border-strong, accent,
success, warning, and danger roles rather than fixed palette values.

## Typography

Atkinson Hyperlegible carries prose and controls. Azeret Mono is reserved for
the lowercase mdbase wordmark, paths, types, and compact state labels. Note
content is 17px with a relaxed 1.7 line height and a maximum readable measure.

## Layout

The desktop app uses three persistent panes: a 176px collection rail, a 304px
virtualized note list, and the editor. A properties inspector appears only when
requested. Types reuse the list-and-document rhythm; settings become one quiet
document rather than a dashboard. Mobile presents each level as a separate
navigable screen.

## Editing

CodeMirror provides Markdown behavior without introducing IDE chrome. Its
focus state uses the normal caret and selection only: the editor surface never
gains a border, outline, or glow. Vim bindings are optional and loaded only
when enabled. Frontmatter opens as typed rows first, with JSON available as an
escape hatch for nested or unfamiliar values.

Creating a note is a short composition step. Nothing is written until the
title, path, selected type, and any required fields are ready and the user
chooses Create note. While an existing note is fetched, a stable document
skeleton preserves the pane geometry and avoids flashing the empty state.
The collection opens into the same three-pane geometry: the first page becomes
usable immediately while the remaining index continues in the note list. A
newly created note is adopted from the create response, so the editor never
waits for a collection-wide refresh or a redundant read.

## Signature

The current Markdown path sits quietly above the title. It can be renamed in
place, making the relationship between the calm note and its durable file
visible without turning the app into a file manager.
