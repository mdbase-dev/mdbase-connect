# mdbase identity system

Status: selected direction

The mdbase mark is a compact piece of Frontmatter: two key-value rows enclosed
by Markdown-style fences. Its first value is blue. The mark makes the product's
core promise visible without relying on a folder, database cylinder, or cloud.
The user's data remains plain, structured, and legible.

## Design idea

The mark has three readings:

1. **Frontmatter.** The upper and lower rows recall `---` delimiters.
2. **A record.** The two middle rows read as keys and values.
3. **A useful value.** Blue highlights the first value, because mdbase exists
   to make the contents of a record useful, not to privilege its schema.

The resulting character should feel quiet, exact, and capable. It is a small
system rather than a pictogram.

## Canonical construction

The native SVG uses a `120 × 120` view box. The visible geometry occupies an
exact `76 × 76` square from `(22, 22)` to `(98, 98)`.

| Property | Native value |
| --- | ---: |
| Element weight | 10 |
| Corner radius | 2 |
| Horizontal gap | 8 |
| Vertical interval | 22 |
| Fence dash | 20 × 10 |
| First key | 12 × 10 |
| First value | 56 × 10 |
| Second key | 28 × 10 |
| Second value | 40 × 10 |

Two proportional relationships lock the middle rows to the fences:

- first key + gap = fence dash;
- second key = fence dash + gap.

Do not change individual elements to compensate at a particular size. Scale
the complete mark from the canonical geometry.

## Color

The default mark uses product ink with one accent value. The dark-surface
version raises the lightness of both colors rather than reversing to pure
white.

| Role | Light surface | Dark surface |
| --- | --- | --- |
| Ink | `oklch(21% 0.018 255)` | `oklch(92% 0.008 255)` |
| Highlighted value | `oklch(45% 0.105 238)` | `oklch(73% 0.105 238)` |

Use the monochrome mark when color reproduction is unreliable, when the mark
must inherit a UI color, or when a one-color process is required. Do not assign
semantic success, warning, or danger colors to the highlighted value.

## Size and clear space

- Use the standard mark at 20px or larger in product UI.
- Use the tightly cropped favicon asset at 16px.
- Keep at least one fence dash of clear space around the visible mark.
- Do not place the mark inside another outlined container unless the platform
  requires an application-icon field.

The mark is deliberately square. Never stretch it to fill a rectangular slot.

## Wordmark and product lockup

Write the name as lowercase `mdbase`. Set it in Azeret Mono at weight 600 with
slightly tight tracking. The product name is `mdbase connect`; `connect` is a
quieter secondary label, never part of the company name.

For a compact product header:

- mark: 20px;
- gap from mark to `mdbase`: 8px;
- `mdbase`: Azeret Mono, 13px, weight 600;
- `connect`: Azeret Mono, 11px, weight 400, muted ink;
- gap between `mdbase` and `connect`: 8px.

Keep the wordmark as live type in product interfaces. This preserves crisp
rendering, localization flexibility for product labels, and accessibility.

## Use in the product

The mark identifies mdbase. It does not indicate sync, connectivity, approval,
or collection health. Pair those states with their own text labels and status
indicators.

Good placements include:

- the shared desktop and portal product header;
- sign-in and pairing screens;
- application packaging and browser metadata;
- documentation covers and repository identity.

Avoid repeating the mark in section headings, empty states, collection rows,
or permission controls. Repetition turns a precise identity into decoration.

The adopted loading and transition behaviors, their semantic assignments, and
live production previews are documented in the
[icon motion system](icon-motion-system.html). Product implementations consume
the shared motion classes from `packages/ui/motion.css`.

## Assets

- [Default mark](../../assets/mdbase-icon.svg)
- [Dark-surface mark](../../assets/mdbase-icon-dark.svg)
- [Monochrome mark](../../assets/mdbase-icon-mono.svg)
- [Favicon](../../assets/mdbase-favicon.svg)
- [Application icon source](../../assets/mdbase-app-icon.svg)
- [Asset notes](../../assets/README.md)

The original comparison work remains in
[the logo study](../mdbase-logo-studies.html).
