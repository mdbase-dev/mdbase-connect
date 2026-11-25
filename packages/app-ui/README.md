# `@mdbase-dev/ui`

The shared visual foundation of mdbase apps: Editor, Reader, Writer, and any
app that wants to look like part of the family. Nothing here is required to
build on mdbase Connect.

```ts
import "@mdbase-dev/ui/fonts.css";
import "@mdbase-dev/ui/tokens.css";
import "@mdbase-dev/ui/brand.css";

import { Wordmark } from "@mdbase-dev/ui/brand";
import { loadThemePreference, applyThemePreference } from "@mdbase-dev/ui/theme";
import { mdbaseAppHref, withAppUrls } from "@mdbase-dev/ui/apps";

applyThemePreference(loadThemePreference());
```

- `tokens.css` defines semantic roles (`--color-canvas`, `--color-text`,
  `--color-text-soft`, `--color-accent`, ...) for light, dark and system
  themes. Style components with roles, not palette values. Short aliases such
  as `--ink` belong to each app.
  `--color-current` and `--color-on-current` mark the keyboard/pointer current
  choice in completion lists and diagnostics; `--color-selected` stays subtle for persistent selections.
  Each colour that differs by theme is one `light-dark()` value, and `:root`
  uses one scheme at a time. In CSS, `var(--color-text)` resolves as before. In
  script, read a resolved colour from an element (`getComputedStyle(element).color`),
  not the raw property, which is the `light-dark()` expression. An element that
  sets its own `color-scheme` gets that scheme's colours.
- Corners come in three sizes: `--radius-sm` (6px) for controls and rows,
  `--radius-md` (8px) for content blocks and toasts, `--radius-lg` (10px) for
  menus and dialogs.
- `theme` stores the System, Light or Dark choice as `mdbase:theme`.
- `brand` draws the Frontmatter mark, each app's inverted mark, and the
  `mdbase <app>` wordmark. Add `motion.css` to animate the mark: loops
  (`orbit`, `scan`, `bounce`, `stream`, `sort`, `hop`), entrances
  (`keys-first`, `drop`, `assemble`), one-shot `saved`/`error` signals, and a
  `progress` fill.
- `mark-activity` is the page-wide store behind the app switcher's mark.
  `SaveNotice` already reports saves and problems to it. For other work, call
  `signalMdbaseMark("saved" | "error")` when a write the person made finishes,
  `trackMdbaseMarkProgress()` (or `useMdbaseMarkProgress(fraction)`) when the
  total is known, and `holdMdbaseMarkBusy(loop)` (or `useMdbaseMarkBusy`) while
  it is not.
- `apps` lists the mdbase apps, exports the MCP setup and endpoint URLs
  (`mcpSetupUrl`, `mcpEndpointUrl`), and builds links that open the current
  collection in another app. Every deployment passes its own URLs to
  `withAppUrls` (or `AppSwitcher`'s `urls` prop, which accepts all official
  apps). Apps without a configured URL are omitted; shared metadata never falls
  back to production origins. `AppSwitcher` accepts any `OfficialAppId` as
  `current`, optional `children`/`className`/`align` for apps with their own
  trigger identity (such as TaskNotes), and an optional `collectionId` when the
  app does not carry `?collection=` in `location.href`. After the apps comes a
  "Your app here" row linking the SDK guide, then an AI assistants submenu
  (pass `mcpUrl={null}` to omit it on custom servers).
- Pass `open` and `onOpenChange` to control the app switcher, as with
  `CollectionSwitcher`. `variant="none"` renders no wordmark trigger, for an
  app that hides its wordmark on phones and offers the apps from its own
  overflow menu. It requires `anchorRef`, an element that stays mounted while
  the menu is open (the overflow menu's button, say): the menu is placed
  against it, presses on it don't dismiss the menu, and Escape returns focus
  to it. Close your own menu without moving focus back to that button; the
  app menu takes focus as it opens.

## Opening screen

Every app opens on the same screen: its mark scanning above `mdbase <app>`
and a line saying what it is opening. Paint it from index.html, before any
script runs, and render `OpeningScreen` from `@mdbase-dev/ui/screens` while
the app loads after that. Both produce the same DOM, so the hand-over is
invisible.

```ts
// vite.config.ts
import { mdbaseOpeningPage } from "@mdbase-dev/ui/opening-page";

plugins: [react(), mdbaseOpeningPage({
  app: "reader",
  title: "Opening your library",
  themeColor: { light: "#fcfcfd", dark: "#1b1d23" },
})];
```

```html
<!-- index.html: keep <meta charset>; drop any theme-color meta and theme script -->
<div id="root"><!--mdbase-opening--></div>
```

```tsx
<Suspense fallback={<OpeningScreen app="reader" title={t`Opening your library`} />}>
```

- The plugin inlines `tokens.css`, `brand.css` and `screens.css` right after
  `<meta charset>`, ahead of the app's own CSS, and writes the
  `theme-color` meta. It refuses an index.html without the marker or charset,
  or one that already sets theme-color.
- Its one inline script applies the saved theme before first paint. Until
  the app replaces the page, it also turns a failed bundle or startup error
  into the screen's failure state, with a Reload link. An app with a script
  CSP must allow that script's hash.
- Without JavaScript the page shows that the app needs it. After eight
  seconds, CSS alone shows "Still opening? Check your connection." with a
  Reload link.
- The static page is English: it paints before any catalogue loads. The
  React screen takes over in the reader's language.
- `OpeningScreen`'s `error` shows the failure state, and `onRetry` adds Try
  again. `layout="panel"` renders a `div` without the reload hint, for a
  screen inside the app's own chrome.

## Switch and segmented control

Both need `controls.css`.

```tsx
import { Switch } from "@mdbase-dev/ui/switch";
import { Segmented } from "@mdbase-dev/ui/segmented";

<Switch checked={wrap} onChange={setWrap}>Wrap long lines</Switch>
<Segmented aria-label="View" value={view} onChange={setView} options={[
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
]} />
```

- `Switch` is for a setting that takes effect at once; use `Checkbox` for a
  choice that waits for a Save. Its children are its label. Without children it
  renders the control alone, for a row that lays out its own text: name it
  with `aria-label` or `aria-labelledby`. Other button props pass through.
- `Segmented` is one choice among two to four short options that stay in
  view. It is a group of native radios, so arrow keys move the choice. Use
  `Select` for more options or long labels.
- `ThemeSelect` from `@mdbase-dev/ui/theme-select` is the segmented control
  for System, Light and Dark.

## Motion

`motion.css` (which `controls.css` imports) defines the durations and curves.
Something a hand just moved, such as a released button, a switch thumb or a
segmented thumb, settles on `--motion-spring` with `--ease-spring`, a spring
with about 2% overshoot; the press itself takes `--motion-press`. Menus, lists
and dialogs open on the same spring, from the corner beside their trigger.
Reduced motion sets every duration to zero, so nothing needs its own override.

## Icon-button tooltips

Import `Tooltip` from `@mdbase-dev/ui/tooltip` and include `controls.css`.
Wrap one icon button or link in `<Tooltip label="Search" shortcut="mod+k">…</Tooltip>`.
Localize the label in the caller. The optional shortcut uses the same notation and
platform labels as the command palette and sets `aria-keyshortcuts` on the button.
The button keeps its ref and handlers; a native manual popover adds no layout box
or focus stop. Escape dismisses a visible tooltip before the parent dialog;
the bubble remains visible while hovered, with 120 ms to cross the gap.
Only the supplemental shortcut is linked as a description, preserving existing
button names and descriptions. Hover waits 400 ms, keyboard
focus is immediate, and a recently closed tooltip keeps the next one immediate
for 800 ms. Touch presses do not show a tooltip. Scroll, resize, window blur,
press, or an unavailable trigger cancels pending and visible hints.

## Toasts

Mount one `Toaster` from `@mdbase-dev/ui/toast` inside the app's locale provider
and import `@mdbase-dev/ui/toast.css` after `controls.css`. Call
`toast(message, undo?)` with localized copy and, when applicable, a real inverse
mutation. The toast stays for five seconds (eight with Undo), pauses on hover
or focus, and queues up to three more messages. Unmounting the owner clears the
queue.

For anything else, pass options in place of the undo function:

```ts
toast("Collection shared", { tone: "success" });
const dismiss = toast("Could not save", {
  tone: "error",
  sticky: true,
  action: { label: retryLabel, onAction: retry, dismiss: true },
});
```

`tone` puts a tick or an exclamation mark before the message, `sticky` keeps
the toast until it is dismissed, `durationMs` sets another time, and
`dismissible: false` removes the close button. `toast` returns a function that
dismisses that toast.

## Languages

The `/i18n` entry exports `uiCatalogues: CatalogueSource` with synchronous
English and lazy local-deployment JSON for `fr de es ja ko pt ru zh`.
Compose it once with the app's catalogue using `@mdbase-dev/i18n`:

```tsx
import { i18n, uiCatalogues } from "@mdbase-dev/ui/i18n";
const runtime = createI18nRuntime({ i18n, english: appEnglish, loadLocale, libraries: [uiCatalogues] });
// Wrap the app once in LocaleProvider with this runtime.
```

Core-macro presentation helpers use the shared Lingui singleton; do not compose
into an unrelated isolated instance. Keep React and Lingui deduplicated in app
bundlers. No form is remounted on a locale switch. Build output includes all
ten catalogues and transformed macros; consumers do not compile library source.
PO files are the only authoring format. Builds use the kit CLI to prune obsolete PO
entries before compilation, including English fallback; `prepack` runs strict catalogue
checks and rebuilds so stale compiled messages cannot enter a fresh tarball.
Run strict `i18n:check` before release: a fallback-capable development build does
not prove a language is complete.
Reviewed identical terms are Esc/ID, the literal example email, and French
Collection/Collections (allowlisted per generated ID).

Give every new message a `context` (for example `t({ message: "Clear", context: "Date picker" })`).
Apps compose this catalogue with their own, and a message without a context gets the same
generated ID as an app's message with the same English text, so one would replace the other's
translations. `i18n-context-baseline.json` freezes the older messages that have none; the
catalogue test rejects any other.

## Command palette

`CommandPalette` from `@mdbase-dev/ui/command-palette` accepts an optional
`groupLabel(groupId: string): string` callback for localized group headings.
For example, pass `groupLabel={readerCommandGroupLabel}`. Without it, the heading
remains the command's `group` string. This is presentation only: keep `Command.group`
and `showAll` values as stable IDs. Group order, browsing limits and search matching
still use those IDs; translated headings do not change matching or merge groups.
Re-render with the current locale's callback to update the presentation.

## Link picker

`LinkPicker` from `@mdbase-dev/ui/link-picker` is the field for linking one
record to another: type to find a record, or make a new one of a given kind
from what was typed. Include `controls.css`.

```tsx
<LinkPicker
  label={t`Author`}
  query={query}
  onQueryChange={setQuery}
  options={matches.map((person) => ({ id: person.path, title: person.name, detail: t`Person` }))}
  creates={[{ id: "person", label: t`New person` }]}
  emptyMessage={t`No matching people.`}
  onPick={(option) => link(option.id)}
  onCreate={(create, title) => createAndLink(create.id, title)}
/>
```

The app matches and ranks `options` for the current `query`; the picker does not
filter. `creates` are listed after the matches once something is typed, unless a
match already carries exactly that title. Every string is passed in, so the
picker adds nothing to the shared catalogue. Focus stays in the text field: the
first Escape closes the list, the second calls `onClose`, as does leaving the
field. `linkPickerRows(query, options, creates)` gives the same rows to a surface
that draws its own list, such as an editor's completion popup.

## Quick create

`QuickCreate` from `@mdbase-dev/ui/quick-create` is a short form for a record
made in passing, such as one chosen from a link picker's create row when its
type needs more than a name. Include `controls.css`.

```tsx
{creating && <QuickCreate
  title={t`New book`}
  name={creating.title}
  nameLabel={t`Title`}
  onNameChange={(title) => setCreating({ ...creating, title })}
  anchor={() => field.current?.getBoundingClientRect()}
  submitLabel={t`Create and link`}
  blocker={creating.isbn ? undefined : t`Give the ISBN.`}
  onSubmit={createAndLink}
  onClose={(refocus) => { setCreating(undefined); if (refocus) field.current?.focus(); }}
>
  <IsbnField value={creating.isbn} onChange={(isbn) => setCreating({ ...creating, isbn })} />
</QuickCreate>}
```

Render it while the form is wanted. It opens in the top layer beside `anchor`
(called again on scroll and resize; return nothing once that place has gone),
puts the keyboard in the first field after the name and keeps Tab inside. The
app supplies the fields as children and every string except Cancel. Escape and
Cancel call `onClose(true)`; a press elsewhere calls `onClose(false)`, because
the focus has already moved. A list open inside the form takes the first Escape.

## Anchored popover

`AnchoredPopover` from `@mdbase-dev/ui/anchored-popover` is a small panel beside
the control that opened it, for a value to choose or type: a calendar, a
checklist, a short form. Include `controls.css`.

```tsx
<button ref={anchor} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>{t`Due`}</button>
{open && <AnchoredPopover anchor={anchor} label={t`Due date`} onClose={() => setOpen(false)}>
  <Calendar value={due} onPick={pick} />
</AnchoredPopover>}
```

Render it while it is wanted. It opens in the top layer, follows its anchor, and
puts the keyboard in the element marked `data-autofocus`, or failing that in its
first control. Escape calls `onClose(true)` with the focus back on the anchor; a
press elsewhere calls `onClose(false)` after the field being typed in has lost
the focus, so a field that commits when it is left keeps what was typed. A list
or menu open inside it takes the first Escape. A menu of actions is `Menu`.

## Date picker

`@mdbase-dev/ui/date-picker` has `DateField`, a date that reads as a date and
opens a calendar to change it, and `Calendar`, the month on its own for a panel
that is already open. Dates go in and out as they are stored (`2026-11-28`).
Include `controls.css` and `date-picker.css`; `filter-builder.css` and
`properties.css` already bring the second with them.

```tsx
<DateField value={due ?? ""} label={t`Due`} placeholder={t`No date`} onChange={setDue} />
```

The calendar's field takes a typed day: a stored date, today, tomorrow or
yesterday in the interface's language, a weekday (the next one), or a number of
days or weeks from today (`+3`, `-1`, `2w`). The arrow keys move through the
days and Page Up and Page Down through the months, from the field or the grid.
The week starts where the reader's locale starts it. `readDay(text)` and
`formatDay(value)` read and write a day the same way outside the picker. The
text is in the shared catalogue; pass `labels` to word any of it differently.

## Combo

`Combo` from `@mdbase-dev/ui/combo` is a text field with a list of plain values
under it: type to narrow the list, choose a row, or take what was typed. It is
the link picker given values in place of records. Include `controls.css`.

```tsx
<Combo
  label={t`Stage`}
  value={stage}
  options={stages.map((value) => ({ value }))}
  newLabel={t`Use`}
  emptyMessage={t`Nothing matches.`}
  commitOnBlur
  onCommit={(value) => setStage(value)}
/>
```

Without `newLabel` only the options can be chosen. `accepts` says whether typed
text may be taken, and `emptyMessage` shows when it may not and nothing
matches. `onCommit(value, made)` reports whether the value was typed rather than
chosen. Every string is passed in.

## Filter builder

`FilterBuilder` from `@mdbase-dev/ui/filter-builder` is an inline filter bar
over a CEL `where` expression. Each filter is a pill: a rule on a field, with
one value or several, or an expression kept as written. Pills combine in nested
all, any and none groups. Include `controls.css` and `filter-builder.css`.

```tsx
<FilterBuilder
  query={where}
  fields={filterFieldsFromProperties(propertiesInUse(records, declared))}
  error={queryError}
  onChange={setWhere}
/>
```

`query` is the expression and `onChange` receives the next one; an expression
the builder cannot show as rules stays an expression pill and is written back
unchanged. `fields` are the properties offered (`fieldsFromJsonSchema` makes
them from a JSON schema). Optional parts: `sharedQuery` and `onSharedChange` add
a second tier of filters that every view applies; `contextVars` offers the
host's `this.*` values to compare with; `lockedFields` keeps the filters on
fields the host owns from being removed; `defaultOpen` opens the list of fields
at once. `parseWhere`, `compileWhere` and `countActive` read and write the same
tree outside the component. The text is in the shared catalogue; pass `labels`
to word any of it differently.

## Properties

`PropertyList` from `@mdbase-dev/ui/properties` shows a record's properties,
each edited in place with the control its value calls for: a choice, a switch, a
date, a number, a list of values, links to other records, or text. Include
`controls.css` and `properties.css`.

```tsx
<PropertyList
  values={record.frontmatter}
  declared={type.fields}
  inUse={propertiesInUse(others.map((other) => other.frontmatter))}
  hidden={(name) => name === "title"}
  records={{ describe, search, open }}
  onChange={(name, value) => update(record.path, { [name]: value })}
/>
```

`declared` is what the record's type says about its properties, in the type's
order: a name, a kind, and where known the values it may take and whether it is
a date. `inUse` is what other records hold, offered when a property is added;
`propertiesInUse` works that out from their values. Properties that hold
nothing stay out of the way until one is added by name or all are shown.
`onChange` receives null for a value that was cleared or a property that was
removed; without it the properties are only shown. `PropertyValue` is one
value's control on its own, and `filterFieldsFromProperties` turns the same
descriptions into the filter builder's fields.

A value with parts of its own is shown part by part under its name, each part
with the control its value calls for, and a list of such values one under
another by place. Either folds away, and starts folded when it holds more than
a few values. `onChange` still receives the whole value of the top-level
property. A declared `group` names its `parts` and says with `rest` what a part
it does not name holds, or `false` when it takes no others; a declared `list`
says with `items` what each value is.

A declared property with `required` always has a row, is marked, and cannot be
taken off. `errors` shows what is wrong with a value under it, keyed by the
value's path: `due`, `progress.page`, `steps.0.title`. A property declared with
the `date-time` format is edited as a date and time in the reader's own zone and
stored in UTC.

```tsx
<PropertyList
  values={record.frontmatter}
  declared={[
    { name: "title", kind: "text", required: true },
    { name: "progress", kind: "group", rest: false, parts: [{ name: "page", kind: "number" }, { name: "of", kind: "number" }] },
    { name: "steps", kind: "list", items: { name: "", kind: "group", parts: [{ name: "title", kind: "text", required: true }] } },
    { name: "author", kind: "text", link: { many: false } },
  ]}
  errors={{ "progress.page": "Must be at least 1." }}
  records={records}
  onChange={change}
/>
```

`records` looks other records up for properties that link to them: `describe`
names a record and `search` finds records for what was typed. A property
declared with `link` holds one link or several whatever its value looks like;
without a declaration, a value that is a whole wikilink is taken for one. A host
whose collection resolves links passes `resolve`, and `link` to write a link in
the collection's own form. `creates` lists the kinds of record a property's
picker can make and `create` makes one, then links it through the
`PropertyLinkCreation` it is handed.

## Live preview

`livePreview()` from `@mdbase-dev/ui/live-preview` renders Markdown in a
CodeMirror 6 editor while keeping the document plain text. Import
`@mdbase-dev/ui/live-preview.css` beside it. Parse with GitHub-flavoured
Markdown (`markdownLanguage`) so tables, strikethrough and tasks render.

```ts
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentListItem, livePreview, outdentListItem } from "@mdbase-dev/ui/live-preview";

const extensions = [
  markdown({ base: markdownLanguage }),
  livePreview({ linkMissing: (state, link) => !resolves(link) }),
  keymap.of([{ key: "Tab", run: indentListItem }, { key: "Shift-Tab", run: outdentListItem }])
];
```

- Source shows only where a focused selection touches it, so an unfocused note
  always reads as rendered text. While the mouse button is down the reveal
  holds still, so a click never turns into a drag across moving text.
- Revealed heading and quote marks sit in the margin and list prefixes keep
  their width, so revealing source never moves the text being edited.
- Home stops at an item's or heading's text before the line start. Task
  checkboxes toggle with a click or Space.
- The app owns link resolution: `linkMissing` marks links that point nowhere,
  and `refresh` rebuilds when app state behind it changes. Rendered links carry
  `data-link-*` attributes for the app's own click handling.
- Tables are edited in place as a grid over their Markdown source. Tab,
  Shift-Tab and Enter move between cells and grow the table, a typed `|` is
  escaped, and edits across cells keep every row's columns. Dragging a grip
  moves its row or column; clicking it, or the context menu (Shift-F10),
  inserts, moves, aligns, sorts and deletes rows and columns; the menu uses
  the shared `mdbase-menu` styles. A selection running from one cell into
  another selects the block of cells between them: Delete empties it, and copy
  writes Markdown (`text/plain`) and an HTML table (`text/html`). Pasted
  spreadsheet, Markdown and HTML grids fill cells. Tables need
  `@codemirror/view` 6.42.1 or later.
- `isRevealed(state, from, to)` and `livePreviewReveal` let an app's own
  decorations (embeds, for example) follow the same reveal.

## Collections

Import `@mdbase-dev/ui/collections` and `@mdbase-dev/ui/collections.css`.
The stylesheet includes the shared tokens, controls and dialog styles; no separate imports are needed.
Every component takes the SDK front door from `createMdbase` (an optional peer
dependency) and `app: { name, mark? }`.

```tsx
import { CollectionGate, CollectionSwitcher } from "@mdbase-dev/ui/collections";
import "@mdbase-dev/ui/collections.css";

<CollectionGate mdbase={mdbase} app={{ name: "Reader" }} extraActions={<TrySample />}>
  {(connection) => <Shell header={<CollectionSwitcher mdbase={mdbase} app={app} />} />}
</CollectionGate>;
```

- `CollectionGate` covers sign-in, choosing, approval, setup review and
  problems, and renders its children once the phase is `ready`. A live problem
  then shows as a banner above them. `layout="panel"` fits inside a shell or a
  dialog.
- The gate calls `mdbase.start()` itself while the front door hasn't started
  (`autoStart`, default `true`). It makes one call however many gates render,
  and none once the app has started it, so apps can drop their own `start()`.
  Pass `autoStart={false}` to start it yourself. `CollectionPanel` does the same.
- `extraActions` holds the app's own actions. On the signed-out screen they sit
  beside Sign in. On every other gate screen they lead the footer, never under
  a problem. Pass a function `(view) => node` to vary them by `view.kind`, or
  return `null` to hide them.
- `CollectionSwitcher` (`variant` `full`, `compact` or `icon`) is the header
  switcher: a popover, and a bottom sheet below 640px. `icon` puts the app's
  icon before the name, or `icon="mark"` the open collection's initials. In
  the `icon` variant it replaces the folder glyph.
- `signedOutExtra` is shown under Sign in in the switcher while no account is
  signed in. An app that opens straight into work before connecting never
  shows the gate's signed-out screen, so it puts the signed-out content from
  `extraActions` here as well.
- Pass `open` and `onOpenChange` to control the switcher; `onOpenChange` is
  called for every open and close it makes itself, controlled or not.
  `variant="none"` renders no trigger, for an app that opens the switcher from
  its own control, such as an item in an overflow menu. It requires
  `anchorRef`, an element that stays mounted while the switcher is open (the
  menu's button, say): the popover is placed against it, and focus returns to
  it when the switcher or a row dialog opened from it closes. Close your menu
  without moving focus back to that button; the switcher takes focus as it
  opens.
- `rowDetail(row)` adds a second line to each collection row, such as where it
  lives or which account it belongs to. `row.entry` is the SDK's entry.
- `sections` lists collections the app knows about and the SDK doesn't (local
  or private ones). Each section is `{ id, title, items, onSelect, onClose?,
  empty? }`, and each item is `{ id, name, detail?, current?, disabled? }`.
  Sections appear after "Your collections" on the gate's choosing and
  signed-out screens and in the switcher. Selecting an item asks
  `onBeforeLeave("switch")` when something is open, closes any other open
  item, then calls `onSelect` from the click. Mark the open item `current`.
  The gate then renders `renderAppCollection(item, { section, chooseAnother })`
  instead of its screens, and `chooseAnother()` (or "Choose a different
  collection" in the switcher) calls `onClose` to return to the list. Choosing
  an SDK collection also calls `onClose` first.
- A section item's `actions` fill its row menu, the same "…" menu SDK
  collections have: `{ id, label, onSelect(item, context), danger?, disabled? }`.
  `danger` actions show in the danger colour; confirm before acting.
  `context.confirmDelete(onClose?)` opens `DeleteCollectionDialog` for the
  item (the person types its name; the SDK deletes it by the item's `id`), and
  `onClose(outcome)` reports how it ended:

  ```tsx
  actions: isOwner ? [{ id: "delete", label: "Delete collection…", danger: true,
    onSelect: (_item, { confirmDelete }) => confirmDelete((outcome) => { if (outcome === "deleted") reload(); }) }] : []
  ```
- `CollectionPanel` combines the gate screens with the switcher list, for
  settings dialogs. `CollectionProblem` shows one problem with its fix, either
  the current one or an error the app passes in.
- `onBeforeLeave(intent)` lets the app confirm before a switch, an add, choosing
  another collection or signing out. Return `true` or a promise. The Connect
  window opens straight after it, with no other await in between.
- `allowDelete` enables "Delete collection…" for owners. `copy` overrides
  strings from `defaultCollectionCopy`. `DeleteCollectionDialog`'s
  `onClose(outcome)` reports `"deleted"`, `"cancelled"` (closed without trying)
  or `"failed"` (closed after a refused delete).
- `collectionView(snapshot)` is the headless model behind the components:
  heading, rows and a notice with its control.
- Hosts that don't use React call
  `mountCollectionUi(element, { part: "panel" | "switcher" | "problem", ...options })`,
  which returns `{ update, unmount }`. React and react-dom must be installed.

### Testing

The focus and popover code reads the global `window` and `document`, not the
rendered element's document. Test files that use a jsdom environment
(`// @vitest-environment jsdom`) already have them. A Node test that creates
its own window has to make it global before rendering:

```ts
import { shareTestDocument } from "@mdbase-dev/ui/collections/testing";
import { JSDOM } from "jsdom";

const restore = shareTestDocument(new JSDOM("<!doctype html><body></body>").window);
afterAll(restore);
```

### Restyling

Map these properties anywhere up the tree (`:root` is fine) instead of
overriding internals. Each one falls back to the app-ui token, then to the
built-in value.

| Property (`--mdbase-collections-…`) | Used for | app-ui token | Built-in |
| --- | --- | --- | --- |
| `accent` | filled actions, focus, the current row | `--color-accent` | blue |
| `on-accent` | text on the accent | `--color-on-accent` | near white |
| `surface` | popovers, sheets, dialogs, rows | `--color-surface` | near white |
| `canvas` | the gate page background | `--color-canvas` | near white |
| `text` | primary text | `--color-text` | near black |
| `text-soft` | secondary text | `--color-text-soft` | grey |
| `border` | hairlines | `--color-border-strong` | light grey |
| `danger` | errors and destructive actions | `--color-danger` | red |
| `warning` | warning text | `--color-warning-text` | amber |
| `scrim` | behind dialogs and sheets | `--color-scrim` | `rgb(0 0 0 / 0.3)` |
| `current-bg` | the open collection's row | (none) | accent 9% into surface, mixed in oklab |
| `font` | font family | `--sans` | `system-ui, sans-serif` |
| `font-size` | body text | `--font-size-ui` | `0.8125rem` |
| `font-size-caption` | row details, chips, labels | `--font-size-caption` | `0.75rem` |
| `font-size-section` | leads, panel headings | `--font-size-section` | `0.9375rem` |
| `font-size-heading` | the gate heading | `--font-size-heading` | `1.5rem` |
| `font-weight-strong` | names, headings, buttons | `--font-weight-semibold` | `600` |
| `radius-sm` | rows, buttons, fields | `--radius-sm` | `4px` |
| `radius` | lists and cards | `--radius-md` | `8px` |
| `radius-lg` | popovers, dialogs, sheets | `--radius-lg` | `12px` |
| `elevation-low` | menus | `--elevation-low` | soft shadow |
| `elevation-high` | popovers and dialogs | `--elevation-high` | deeper shadow |
| `control-height` | button and row height | (none) | `36px`, `44px` on touch |

Motion reads `--ease-standard`, `--motion-quick` and `--motion-spin`
(`150ms` and `700ms` built in), and reduced motion slows the spinner. The
built-in colours are light-theme values: an app with a dark theme and no
`tokens.css` maps the colour properties.

## Shared feedback

Import `@mdbase-dev/ui/feedback` and `@mdbase-dev/ui/feedback.css`, alongside
`tokens.css` and `controls.css`. Place one `FeedbackProvider` above the app shell
(and its error boundary); place `FeedbackButton` in a quiet, accessible shell
location. `useFeedback().open("problem")` opens the same form from an error action.

```tsx
import { FeedbackButton, FeedbackProvider, feedbackApplication,
  resolveFeedbackEndpoint, useFeedback } from "@mdbase-dev/ui/feedback";
import "@mdbase-dev/ui/feedback.css";

<FeedbackProvider
  endpoint={resolveFeedbackEndpoint(configuredFeedbackUrl, development)}
  application={feedbackApplication("mdbase reader", "library", revision, environment)}
  turnstileSiteKey={configuredPublicSiteKey}
  collectionName={optionalCollectionDisplayName}
>
  <YourAppShell><FeedbackButton /></YourAppShell>
</FeedbackProvider>;
```

Products: `mdbase editor`, `mdbase reader`, `mdbase writer`, `mdbase connect`.
Views must be fixed identifiers, never URLs or document paths. Application/build
metadata is always included and previewable; reply email, collection name,
problem diagnostics, and a screenshot are optional. A single, initially collapsed
**What gets sent** disclosure holds app details and optional diagnostic/collection
controls, rather than repeating explanations around the form. Collection-name consent
resets if the name changes. A missing or invalid endpoint hides entry points.

For a **user-visible** failure, call `useFeedback().reportError({ code:
"save_failed" })`. Use the exported `FeedbackErrorCode` union and optional HTTP
status, not raw errors. Cancellation does nothing; background retries should not
call it. The bug wiggles twice, at most once per 30 seconds, and never moves with
reduced motion. It does not install global exception listeners or telemetry.

The form opens focused on its description. Capture starts only on **Attach
screenshot**, closes the native modal before requesting `getDisplayMedia`, then
restores the form/draft and stops every track. Unsupported browsers can choose an
image instead. Draw/highlight/blackout, undo/reset, and keyboard markup export one
flattened raster; blackouts replace whole pixels and are painted last. Uploads
are bounded PNG/JPEG, dimension-checked before decoding and re-encoded to discard
metadata and filenames. Only the explicitly included final image is submitted.
Opening markup excludes the image until Apply; cancelling or failing to apply
redactions leaves the original excluded unless the user explicitly includes it.

Drafts and the 30-event/five-minute diagnostic buffer are in-memory per provider.
Cancel preserves the draft; successful dismissal clears it. No collection/auth
SDK, persistence, public issue tracker, or feedback transport other than the
configured stateless Worker is required. Turnstile loads when the form opens if a
public key is configured. Submission omits credentials and referrers, retains the
request ID for unchanged retries, and resets verification tokens after attempts.

See [shared-feedback.md](../../docs/shared-feedback.md) for the Worker contract,
rollout order, integration status, and regression checks.
