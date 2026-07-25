# Product interface foundations

Status: design direction for desktop and portal

The Frontmatter mark expresses a useful product model: bounded data, visible
structure, and selective emphasis. The interface should carry those qualities
without imitating the logo in every component.

## Product character

mdbase connect should feel like a well-made system utility:

- **bounded:** users can see which collection and authority a decision affects;
- **structured:** labels, values, permissions, and consequences align clearly;
- **selective:** accent color appears only where attention or action matters;
- **calm:** ordinary operation is quiet, including ordinary online operation;
- **local-first:** computer-owned paths and authorization remain visibly local.

The design is restrained, but not anonymous. Its character comes from precise
alignment, plain language, thin rules, and the contrast between human-readable
labels and technical values.

## From mark to interface

| Mark element | Product expression |
| --- | --- |
| Upper and lower fences | Explicit boundaries around a decision or data scope |
| Equal element weight | One consistent border and control vocabulary |
| Even vertical rhythm | Stable rows that remain easy to scan |
| Key-value pairs | Labels beside concrete values, not prose-heavy cards |
| Blue first value | The current choice or primary action receives emphasis |
| Square silhouette | Compact identity that does not dominate the task |

These are relationships, not decorative motifs. Do not turn every divider into
three dashes or every value into a blue bar.

## Layout grammar

Use an uninterrupted canvas. Sections begin with a heading and, where density
requires it, one full-width rule. Related records form aligned rows.

- Desktop content width: up to `960px` inside the shared `70rem` shell.
- Product header: full-width rule, compact identity at the left, state at the
  right.
- Dense rows: identity, target, state, actions.
- Decision rows: label and explanation at the left; control at the right.
- Inline configuration: expand beneath its owning row.
- Empty state: plain copy plus one next action.

Use cards only when an item must behave as a portable object with its own
boundary. A collection row, permission row, or setting does not need a card.

## Spacing

Continue using a 4px base unit. Prefer the following working intervals:

| Interval | Use |
| --- | --- |
| 4px | Tight label and supporting-text pair |
| 8px | Icon, status, or compact control gap |
| 12px | Row-internal grouping |
| 16px | Form and inline-panel grouping |
| 24px | Related component groups |
| 32px | Major content group |
| 48 to 56px | Separate product sections |

The logo's exact dimensions do not become a second spacing system. Its lesson
is consistency, not numerology.

## Typography

Atkinson Hyperlegible carries interface copy. Azeret Mono identifies values
that are genuinely technical: paths, origins, versions, IDs, operation names,
and the `mdbase` wordmark.

- Page title: 26px, 700, compact line height.
- Section title: 16 to 17px, 700.
- Row title: 14px, 700.
- Body: 13px, regular.
- Supporting copy: 12px.
- Metadata: 10 to 11px, usually mono.

Do not set ordinary explanatory copy in mono. Do not use uppercase tracking as
a repeated heading system.

## Color and emphasis

The canvas and surface remain almost identical. Neutral lines create structure.
Blue is reserved for:

- the highlighted value in the identity;
- keyboard focus;
- current selection;
- the primary action in a consequential decision;
- links where the text alone does not establish affordance.

Connection, warning, and destructive states retain their semantic colors and
always include text. The brand accent is never used as a generic positive
state.

## Components

### Product header

Use the 20px Frontmatter mark with the live-type product lockup. The right side
shows one state label and its context. Do not show the identity mark again in
the current view.

### Buttons

Buttons remain quiet, rectangular controls with a 3 to 4px radius. The primary
action is distinguished by text, border, and focus treatment rather than a
large filled rectangle. Destructive actions use direct verbs such as `Revoke`
or `Remove from mdbase connect`.

### Status

Pair a small colored dot with an explicit label. Status language answers one
question at a time:

- authority: local or hosted;
- availability: online, offline, or paused;
- route: direct or through mdbase;
- access: pending, allowed, or revoked.

Do not compress several of these into one ambiguous badge.

### Key-value rows

Use key-value rows for collection facts, connection details, and settings.
Keys remain short and quiet. Values carry the useful information. Technical
values may use mono, but collection names and human labels stay in the primary
typeface.

### Permission decisions

Keep the selected collection, requested actions, optional notification rules,
and consequence visible in one reading order. Progressive disclosure may hide
individual operations, but never the total count or the decision's scope.

## Iconography

Interface icons should share the mark's compact, rounded geometry without
copying its arrangement.

- Use 16px and 20px optical sizes.
- Prefer a 1.5px stroke at 16px and 1.75px at 20px.
- Use 2px corner radii where a filled rectangle is required.
- Avoid filled circles as generic decoration; reserve dots for status.
- Do not place icons above headings.

## Motion

Motion communicates state:

- 150 to 200ms ease-out for hover, focus, tab changes, and inline disclosure;
- no page-load choreography;
- no pulsing connection indicators;
- no layout animation for changing lists;
- respect `prefers-reduced-motion`.

## Accessibility checks

- WCAG 2.2 AA contrast for text and controls.
- A visible focus ring on every interactive element.
- Status communicated with text, not color alone.
- Minimum 34px control height and a larger hit target where touch is plausible.
- Permission language describes concrete actions.
- Paths stay available to local users without being exposed to remote services.
