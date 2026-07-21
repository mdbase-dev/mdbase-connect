# Design system

## Direction

A bright laptop in ordinary daylight, used for long-form writing. The interface
is an almost-white sheet divided by fine rules into a collection rail, a note
list, and a generous editor. There are no floating cards and almost no chrome.

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

## Typography

Atkinson Hyperlegible carries prose and controls. Azeret Mono is reserved for
the lowercase mdbase wordmark, paths, types, and compact state labels. Note
content is 17px with a relaxed 1.7 line height and a maximum readable measure.

## Layout

The desktop app uses three persistent panes: a 176px collection rail, a 304px
virtualized note list, and the editor. A properties inspector appears only when
requested. Mobile uses the same hierarchy as three navigable screens.

## Signature

The current Markdown path sits quietly above the title. It can be renamed in
place, making the relationship between the calm note and its durable file
visible without turning the app into a file manager.
