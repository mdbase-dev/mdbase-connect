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
- `apps` lists the mdbase apps and builds links that open the current
  collection in another app. Lab and local builds pass their own URLs to
  `withAppUrls`.

## Collections

Import `@mdbase-dev/ui/collections` and `@mdbase-dev/ui/collections.css`.
`tokens.css` is optional: without it every value falls back to a built-in one.
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
| `warning-edge` | the warning notice's edge | `--color-warning` | amber |
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
