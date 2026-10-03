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
requested. Above 1120px it docks beside the editor without covering document
text. The writing column keeps its 760px measure whenever the narrowed pane
can fit it, sliding toward the left over the shared 240ms motion token. Only a
pane narrower than the measure rewraps text. Reduced motion makes docking
instant; direct sidebar resizing also follows the pointer without animation.
At tablet/mobile widths the inspector is modal, with a scrim, inert background,
trapped focus, Escape dismissal and focus restoration. Between 761px and 1120px the collection rail starts hidden until
someone opens it. Note rows keep one fixed height and read title, a one-line
excerpt (the type's declared description field, else the opening prose), then
time and folder; a declared type appears as muted plain text, never in place of
the folder. Selection has a persistent edge marker: accent-tinted while the list
has focus, neutral while writing. Rows never open a hover preview; their excerpt
remains available to assistive technology. Search results are ordered by relevance without date groups.
Types reuse the list-and-document rhythm; settings are one quiet document
rather than a dashboard. Section headings sit above their content; preference
rows share a steady rhythm, collection facts stay compact, and technical facts
live behind Details. In the collection rail, All notes, Types, and
Settings remain the primary editing group. One header trigger combines the brand
lockup and current collection and opens the collection switcher; it includes
recent collections, connecting another collection, the Connect workspace, and
Send feedback. Feedback is not squeezed beside the connection status.
The independently scrolling middle contains All notes, the folder tree without
a section heading, and a quiet New folder action. Types, Settings, and Connect
form a fixed bottom group above connection status, so large folder trees never
push them out of reach. Keyboard order follows the visual order: header, note
and folder navigation, New folder, Types, Settings, Connect, then status actions.
Connect remains visibly secondary until a pending authorization count requires
attention. Counts use
UI text with tabular numerals and appear only on hover, focus, or the selected
row; accessible names always include them.

Folder context menus provide Rename folder and Move to; F2 renames the focused
folder. Dragging folders or notes onto a folder moves them there; All notes is
the collection-root target. Hovering a collapsed folder expands it after 600ms.
Folder changes first review the complete subtree and links using revision-aware
rename preflights, then require one confirmation with note and affected-link
counts. Execution updates references, reports progress, and lists partial
failures without rolling back accepted changes. Folder changes that contain
attachments are blocked with an embed-safety explanation until attachment
reference rewriting is supported; note-only moves leave attachments untouched.
Existing destination folders are not merged implicitly; exact-path collisions
are rejected before writing. After a partial change, remaining notes can be
moved individually to the destination.

Mobile (≤760px) presents each level as a separate navigable screen, with 44px
touch targets and safe-area padding. The note bar contains only Back and More;
the complete path sits subtly above the title, and Rename path, New note and
Quick open live in More. List screens have a labeled, filled New note action.
Properties take over the screen, and quick open fits the available viewport
rather than keeping its desktop keyboard-help footer.

## Connect account screens

Authentication, account setup, and password recovery share one centered,
mobile-safe column with the `mdbase connect` lockup and editor typeface. One
heading and short explanation introduce the task. The committing action is a
filled accent button; recovery, account switching, and legal links remain quiet
and theme-aware. Email and identity providers are separated by one “or” divider,
never by rules between providers. Provider controls reserve their space while
loading and offer retry on failure. Native form constraints surface inline with
visible focus and screen-reader descriptions.

Connect management retains its existing document layout, with sentence-case
navigation, proportional counts, and the same primary-action hierarchy.

## Editing

CodeMirror provides Markdown behavior without introducing IDE chrome. Its
focus state uses the normal caret and selection only: the editor surface never
gains a border, outline, or glow. Vim bindings are optional and loaded only
when enabled. More is one menu on both desktop and mobile, with separators
between note actions, document views (outline and Linked from), insertion
(Attach file), and help (shortcuts and Check note). Mobile puts New note and
Quick open first; there is only one Rename path and one Attach file action.
Menus scroll when viewport space is limited, and keyboard focus stays visible.
Frontmatter opens as typed rows first, with JSON available as an
escape hatch for nested or unfamiliar values. The inspector offers quiet Fields
and JSON tabs; complete Markdown source lives behind the property options menu,
not a third primary tab. Sizes and dates use the UI family at the normal chrome
size. An empty inspector explains what properties are useful for, with a direct
Add property action.
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

New folder is a short two-field flow: folder name and the title of its first
general note. Empty folders are not persisted, so that fact is explained once;
a file path preview appears only after both names are entered. Typed creation
remains in New note, where required fields are available before committing.
Committing actions use the shared filled primary control, and redundant draft
reminders and decorative folder-name placeholders are omitted.

Type editing uses the same quiet document grammar. Field names are inline
editable in the UI family, with compact kind selects, labelled shared Required
checkboxes, and removal in each row's options menu. Row details and YAML remain
available without surrounding every field name in a permanent input box. The
path takes the flexible space in the type bar; its save notice stays at the
trailing edge, never stretched into the centre. The redundant Type definition
eyebrow and table-like column headers are omitted. Application compatibility
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

Routine autosaves stay silent and note rows retain their timestamps while typing.
Only saves lasting more than 1.5 seconds show “Saving…”; failures and conflicts
remain visible with recovery actions. Word count lives in Properties, not the bar.
Ctrl/⌘P opens quick open everywhere; Ctrl/⌘K inserts a link only in note text.

## Embeds and file viewers

Images sit bare on the writing surface with the medium radius and a single
muted caption below; never add a permanent title/path/action bar. Transparent
assets retain their transparency in both themes. Bright image previews are
slightly dimmed in dark mode, without rewriting the underlying file. Previews
have a bounded height; full-size viewing remains available.

Open and Copy path reveal on hover or keyboard focus, and tapping an embed
focuses it on touch screens. Both actions remain keyboard-reachable. Note
transclusions and PDF/file previews use the same quiet title, fine rule and
on-demand actions, not an accented rail or decorative cover. Long transclusions
scroll in a focusable content region. File dialogs use the shared focus trap,
Escape handling and focus restoration; mobile viewers fill the safe viewport.

## Signature

The current Markdown path sits quietly above the title, with the directory
truncated before the filename. It can be renamed in place, making the relationship between the calm note and its durable file
visible without turning the app into a file manager.

## Note actions and discovery

The list header names the current scope, not the collection again. Tags and types
are search filters, suggested by `#` and `type:` or browsed with Search filters.
The active scope is a removable chip in the search field; folders remain in the
rail. New notes inherit the active scope.

Note rows and the document’s More menu share Rename, Move to…, Duplicate, Copy
link, Copy path, and Delete. F2 renames; Ctrl/⌘+Backspace deletes in the list.
Context-menu and Shift+F10 keys open row actions. Ctrl/⌘-click toggles note selection;
Shift-click and Shift+Up/Down extend from the open anchor note. Ctrl/⌘A in the
focused list selects visible notes; Escape clears selection without closing the
anchor. A quiet count and actions menu appears only for multiple notes. The same
batch actions live in selected rows’ context menus: Move to…, Add tag, Remove
tag, Set property, and Delete. Property choices are declared by the selected
notes’ types; only shared, compatible fields can be set together. Dragging a
selected row moves the selection to a rail folder. Batches use revision checks,
report individual failures, and provide one Undo for successful changes. Undo
never overwrites a later property revision and retains failed items for retry.

Pin and Unpin live in note actions. Pins are browser-local and collection-scoped,
with no file writes. Only the unfiltered All notes list groups them at the top;
search relevance and folder/type/tag scopes remain unchanged.

Moving notes rewrites incoming
links and offers Undo, as does renaming. Deletion is immediate, with a six-second
Undo notification that recreates the same path, frontmatter, and body. Undo
notifications announce their result, pause expiry while hovered/focused, and
support Escape to dismiss.

The document bar keeps history, path, Properties, and More. Outline and keyboard
help live in More; `?` opens help outside text inputs. Backlinks are a quiet
Linked from section after the document text, not a competing inspector. Its
lookup remains lazy for large collections. Link previews inside Markdown remain
available; list-row previews do not.
