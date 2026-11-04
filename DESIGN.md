# Design System

This is the single interface spec for mdbase. `PRODUCT.md` holds product intent,
[`core-flows.md`](docs/product-design/core-flows.md) holds interaction and
writing rules, and
[`identity-system.md`](docs/product-design/identity-system.md) holds the mark.
`apps/editor/DESIGN.md` covers what is specific to the Editor.

The direction applies to the whole mdbase family and is built first in the
portal and desktop. [Adoption](#adoption) lists what has not shipped yet.

## Direction

mdbase connect is a conventional, polished product interface: light, minimal and
quick to read. Its influences are Tailscale's plainness and Linear's precision.

Three rules follow from that:

- **Remove before adding.** A page shows what it is for and little else. If
  spacing can separate two things, use spacing instead of a line, box or tile.
- **Personality comes from behaviour, not decoration.** It lives in the status
  glyphs, the Frontmatter mark's motion, how state changes in place, and speed.
  Do not add gradients, illustrations, themed metaphors or mascots.
- **The voice is plain.** Copy states facts in the words of
  [`core-flows.md`](docs/product-design/core-flows.md#product-writing). It is not
  playful, and it does not try to carry the brand.

Calm must not cost clarity. Revoking access, permissions and the state of a
collection stay visible at rest and are never hidden behind hover.

## Color

Role values for light, dark and system themes live in
`packages/app-ui/css/tokens.css`, published as `@mdbase-dev/ui/tokens.css`. Do
not restate values here or use raw values in components.

- **Neutrals** are near-white and near-black with almost no tint. The canvas is
  the only major surface. Sidebars and page content share it.
- **Accent** is the deep blue of the Frontmatter mark. The mark's value is the
  source of truth. Use it for the one primary action on a page, keyboard focus
  and in-progress state. Do not use it for selection fills, tinted backgrounds
  or as a generic positive state.
- **Semantic color** marks meaning only and takes as little space as possible.
  Green is verified connection or completion. Amber is pending attention. Red
  is failure and destructive intent. Denying a request is a complete outcome,
  not a destructive one, so `Deny` stays neutral.
- Provider sign-in buttons keep their required treatment at secondary weight.

## Theme contract

Every surface offers System, Light and Dark. System follows
`prefers-color-scheme`. An explicit choice is stored locally as `mdbase:theme`
and applied before first paint. The shared semantic roles are canvas, surface,
surface-subtle, text, text-soft, text-muted, border, border-strong, accent,
success, warning and danger. Components consume roles, so both themes keep the
same hierarchy.

## Typography

- **IBM Plex Sans**, locally packaged, carries all interface copy, including
  hostnames in lists. Its distinct capital I and clear punctuation keep
  hostnames easy to check. Use weights 400, 500 and 600. Do not load fonts from
  a third party. Scripts Plex does not cover, such as Japanese, Korean and
  Chinese, fall back to system fonts.
- **Azeret Mono** is reserved for paths, source and code, the application origin
  on the approval page, and the `mdbase` wordmark. Counts, dates, sizes and
  versions use the primary family with tabular numerals.
- UI text is 13px on 18px line height. Nothing is smaller than 12px.
- The page title is 20px at weight 600, the only large type on a page.
- Section headings are 13px at weight 500 in muted text. They label a group
  rather than compete with it.
- Row names use weight 500. Supporting values use regular muted text.
- Longer copy, such as consent explanations, uses 15px and is capped near 70ch.
- Labels use sentence case without uppercase tracking.

The product name is always written `mdbase connect`. The wordmark is live type,
as specified in the [identity system](docs/product-design/identity-system.md).

## Layout

- Pages sit on an uninterrupted canvas beside a 224px sidebar with no divider,
  in the portal and in desktop.
- The sidebar has no nav icons. It separates current-collection items (Overview,
  Storage & sync, App access) from account items (All collections, Applications,
  Computers, Account & sessions). Counts appear only for pending action.
- At phone width the sidebar becomes a compact top bar, and rows stack.
- Content sits in a centered column up to 600px wide. Dense tables may widen to
  820px.
- A page opens with its title, status line and one primary action, then anything
  needing attention, then its content. Overview shows status, attention and
  apps with access. Storage belongs on Storage & sync.
- Use a 4px base unit: 4 within a label pair, 8 within a control group, 12 within
  a row, 16 in forms, 24 between related groups, 40 between page sections.
- Use no card, tile or tinted panel unless an item is a portable object with its
  own boundary. A collection, permission or setting does not need one.

Direct Connect entry restores the last valid collection, opens the only
collection when there is one, and otherwise starts at All collections. A
collection is never chosen silently from an ambiguous list.

Portal authentication, pairing, recovery and approval pages each contain one
consequential transaction. Account administration is hosted only on the portal,
and entering it never grants an application a collection's contents.

### Rows

Short lists separate rows with space alone. A list gets a faint rule between rows
when it has more than six rows, more than three columns or rows that wrap,
because then scanning needs the help. Rows keep a stable rhythm of identity,
state, and actions, and each row owns its inline configuration, which expands
beneath it.

## Components

### Status glyph

Status is a 14px glyph beside a text label, from the shared status glyph
component. Each state has its own shape, so none depends on color. Never show a
glyph alone.

| State | Glyph | Color |
| --- | --- | --- |
| Online | Small solid dot | Success |
| Syncing | Ring that fills as a pie with known progress | Accent |
| Connecting | Ring with a turning arc | Muted |
| Paused | Ring with two bars | Muted |
| Offline | Dashed ring | Muted |
| No live status | Plain ring | Muted |
| Needs attention or failed | Solid disc with an exclamation mark | Warning |

States are one drawing, so they morph: a finished sync fills and settles into
the online dot. The status line answers one question at a time, so do not
compress authority, availability, route and access into one label. Show route
only as `Connected directly` or `Connected through mdbase`, and do not ask users
to choose a transport.

### Attention line

Anything needing a decision is one plain line at the top of the page: an
attention glyph, the fact, a muted reason and one action. It has no box or tint.
When the item is resolved, the line folds away. Do not repeat the state beside
the row it refers to, except at phone width, where the line and row can be far
apart.

### Buttons

Buttons share `.mdbase-button`: a filled accent `.is-primary` for the one
committing action, an outlined default for secondary actions, and text-led
`.is-tertiary` for quiet actions. `.is-danger` supplies destructive intent.
Controls are 28px high with a 6px radius, or 40px where input is coarse.
Transactional pages use 40px throughout. Disabled buttons lose the accent and
keep readable text. All actions have hover, visible focus and busy states. Every
target is at least 24px, including text actions.

### Destructive actions

Confirm inline, in the row: the action becomes a named confirmation and a
`Cancel`. Do not use native confirm dialogs. The confirmation names both the
application and the boundary. Show `Revoking` until the authority confirms, as
[`core-flows.md`](docs/product-design/core-flows.md#review-and-revoke-access)
requires. Only then does the row collapse and `Revoked` appear. Revocation has
no undo, because restoring access is a new approval.

### Command menu

`CommandPalette` opens with Ctrl K or ⌘K in the portal and desktop, and from a
quiet `Search` item in the sidebar. It covers navigation and the page's actions.
Every command also exists elsewhere in the interface.

### Other controls

- Switches use `.mdbase-switch` on a native button with `role="switch"` and
  `aria-checked`. The track and thumb both distinguish On from Off.
- Checkboxes use `.mdbase-checkbox` on native inputs, with an explicit check
  mark, indeterminate state, visible focus and disabled styling.
- Switches and checkboxes preserve forced-color cues and expand touch hit areas.
- Key-value rows use short muted keys. Values carry the information.
- Permission scopes are plain checkboxes with concrete action descriptions.
- Empty states are plain text with a single next action and no illustration.
- Dialogs are limited to creating collections and to the command menu. Routine
  configuration and confirmation stay inline. Floating surfaces use a 10px
  radius and the shared elevation.
- Collection metadata expands inline beneath its row. Name and description stay
  visibly tied to `mdbase.yaml`, and availability is a separate immediate
  control.

### Icons

The sidebar and rows work without icons. Where an icon earns its place, use 16px
with a 1.5px stroke. Do not use icons above headings or as decoration.

## Identity

The canonical mark is a square piece of Frontmatter: segmented upper and lower
fences, two key-value rows, and a blue first value. It represents plain-text
structure becoming useful, without implying a cloud, folder or proprietary
database. Use the assets in `assets/`. Construction, sizing and misuse guidance
live in the [identity system](docs/product-design/identity-system.md).

## Motion

Motion is part of the product, not polish added at the end. It explains what
changed, and it never delays the person.

- **State changes in place.** Content folds, slides or morphs, so nothing jumps.
  Sections collapse with animated height, the selected nav item slides, and
  changed values cross-fade.
- **Timing** uses the shared tokens: 120ms for hover and press, 150 to 180ms for
  fades and menus, and 240ms for layout changes, with the shared ease-out.
- **The Frontmatter mark** carries activity through the assignments in the
  [icon motion system](docs/product-design/icon-motion-system.html): an entrance
  on first appearance, `stream` while syncing, `orbit` while connecting, and
  `saved` or `error` once when a write finishes. The mark never replaces the
  status glyph and text. Apps report work through `mark-activity`.
- **One thing at a time.** Status pages do not stagger entrances or run ambient
  loops. A loop runs only while work is running.
- Duration tokens collapse under `prefers-reduced-motion`, nonessential loops
  stop, and every state stays readable without animation.

## Accessibility

Target WCAG 2.2 AA, as set out in `PRODUCT.md`.

- Text and controls meet AA contrast in both themes, including muted text and
  counts.
- Every interactive element has a visible focus ring.
- Status changes are announced, and state is never carried by color or motion
  alone.
- Permission language describes concrete actions.
- Paths stay available to local users and are never exposed to remote services.

## Adoption

This section records where the product differs from the spec. Delete each item
as it ships, and delete the section when it is empty.

- **Editor:** the Plex, neutral, accent, radius and control tokens in
  `@mdbase-dev/ui` reach it only when it repins from the published
  `0.1.0-beta.147`. It keeps its grouped quick open, and its rail status has no
  shared status glyph, because that component lives in `@mdbase/connect-ui`.
- **Not yet built:** `Review versions` for conflicts and `Pause remote access`
  remain in `core-flows.md` without an implementation.
