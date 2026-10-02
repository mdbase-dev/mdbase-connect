# Design system

## Direction

A laptop used for long-form writing in daylight or a dim room. Light mode is an
almost-white sheet; dark mode is a low-glare blue-black writing surface. Both
are divided by fine rules into a collection rail, a note list, and a generous
editor. There are no floating cards and almost no chrome.

## Color

Role values for light, dark and system themes live in
`packages/app-ui/css/tokens.css`, published as `@mdbase-dev/ui/tokens.css`.
Editor's quiet treatment is the canonical palette; do not restate values here.
Syntax, diff, warning, selection, skeleton, and conflict colors have
theme-specific semantic roles.

## Theme contract

The editor offers System, Light, and Dark in Settings. System follows
`prefers-color-scheme`; an explicit choice is stored locally as `mdbase:theme`
and applied before first paint. Components consume canvas, surface,
surface-subtle, text, text-soft, text-muted, border, border-strong, accent,
success, warning, and danger roles rather than fixed palette values.

## Typography

Locally packaged Atkinson Hyperlegible Next Variable carries prose and controls,
with real regular/medium/semibold/bold weights (400/500/600/700). Azeret Mono is
reserved for paths, source/code and the canonical lowercase mdbase wordmark,
not field names, types or state labels. Counts, dates, sizes and versions use
tabular numerals in the primary family. The shared six-step type scale is
12/13/15/17/24/34px: interface chrome defaults to 13px, captions are 12px, and
nothing is smaller. Mobile document titles use the 24px heading step instead
of introducing a seventh size. Note content is 17px with a relaxed 1.7 line
height and a maximum readable measure. Labels use sentence case without uppercase tracking.

## Controls

Use `@mdbase-dev/ui/controls.css`: `.mdbase-button.is-primary` is the filled
accent committing action; the default button is tonal secondary;
`.is-tertiary` is quiet text; `.is-danger` carries destructive intent. Disabled
buttons visibly lose their accent. Fields and menus use the shared corner,
elevation and motion tokens, not local values.

Settings use `.mdbase-switch` with native button activation, `role="switch"`
and `aria-checked`. Native property/type checkboxes use `.mdbase-checkbox`;
Markdown tasks use the same visual treatment with their existing checkbox-role
button. Check marks, thumb positions and focus outlines communicate state
without relying only on color. Preserve labels, keyboard operation,
indeterminate and disabled states, forced colors, touch targets and reduced motion.

Editor styles live under `src/styles/`; `src/styles.css` imports them in cascade
order. `pnpm check:styles` checks editor and shared UI CSS for raw pixel type,
corner radii and ad-hoc shadows outside the canonical tokens file. It runs in
both tests and builds.

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
requested. Between 761px and 1120px the collection rail starts hidden until
someone opens it. Note rows keep one fixed height and read title, a one-line
excerpt (the type's declared description field, else the opening prose), then
time and folder; a declared type appears as a small badge, never in place of
the folder. Search results are ordered by relevance without date groups.
Types reuse the list-and-document rhythm; settings become one quiet
document rather than a dashboard, with technical facts behind Details. In the collection rail, All notes, Types, and
Settings remain the primary editing group. Connect sits in a bottom-aligned
Manage group above connection and account status, visibly secondary until a
pending authorization count requires attention. Mobile presents each level as
a separate navigable screen.

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
drafted body and properties. While an existing note is fetched, the stable
document frame stays in place with concise loading text; it does not impersonate
the note with placeholder content or shimmer. Before collection metadata is
available, a centered status avoids previewing unstable sidebars. The first page
then becomes usable in the three-pane workspace while the remaining index
continues in the note list. A newly created note is adopted from the create
response, so the editor never waits for a collection-wide refresh or a redundant
read.

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
