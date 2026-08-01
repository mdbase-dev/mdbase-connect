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

## Identity

The shared mdbase Frontmatter mark precedes the live-type `mdbase editor`
lockup. It appears on the connection screen, during collection opening, and in
the collection rail. The mark uses the current ink color with one accent value,
so it follows Light, Dark, and System themes without becoming a status
indicator.

Render the mark at 20px. Do not repeat it in note rows, editor headings, empty
states, or collection controls.

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
Open-ended object properties use compact key/value rows with an explicit empty
state; an empty object should not become a miniature code editor. A schema
field named `name` only doubles as the note title when it is textual, so
structured identity fields remain available to the property editor.

Creating a note opens a local title and Markdown body draft immediately. Type
selection remains visible; the suggested path is visible but its editor stays
collapsed until needed. Nothing is persisted until the title, path, selected
type, and any required fields are ready and the user chooses Create note. The
same controlled property fields used by the note inspector appear during typed
creation: required fields stay expanded, optional fields live in a Properties
disclosure, and raw source remains inspector-only. When a type declares
`collection.display.name_field`, that field becomes the prominent name input
and is not repeated among the remaining properties. Without a declared display
field, the prominent input names the Markdown document and similarly named
schema properties remain separate. The initial create operation includes the
drafted body and properties. While an existing note is fetched, a stable
document skeleton preserves the pane geometry and avoids flashing the empty
state. The collection opens into the same three-pane geometry: the first page
becomes usable immediately while the remaining index continues in the note
list. A newly created note is adopted from the create response, so the editor
never waits for a collection-wide refresh or a redundant read.

Type editing uses the same quiet document grammar. Application compatibility
appears as a disclosure within the type, not as a separate dashboard. Each
contract implementation keeps its direct field mapping, JSON Schema-driven
behavior settings, and normalized application view together. Contract IDs,
versions, validation details, and YAML remain available without becoming the
primary language of the task.

Fixed-choice fields use the shared `SelectControl`: a native select for reliable
keyboard, screen-reader, and touch behavior inside one app-owned shell, with a
consistent caret, height, border, focus ring, disabled state, and error state.
Searchable suggestions use `ComboboxInput` and the same listbox surface instead
of browser datalists. Action choices continue to use menu semantics, while
schema date and date-time fields retain platform pickers with shared input
styling.

## Signature

The current Markdown path sits quietly above the title. It can be renamed in
place, making the relationship between the calm note and its durable file
visible without turning the app into a file manager.
