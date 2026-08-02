# mdbase identity assets

The canonical mdbase mark is the Frontmatter direction selected in
[`docs/mdbase-logo-studies.html`](../docs/mdbase-logo-studies.html). It depicts
a small, delimited key-value record with its first value highlighted.

## Files

| File | Use |
| --- | --- |
| `mdbase-icon.svg` | Default mark on light or transparent surfaces |
| `mdbase-icon-dark.svg` | Mark with colors tuned for dark surfaces |
| `mdbase-icon-mono.svg` | Single-color printing, masks, and inherited-color UI |
| `mdbase-favicon.svg` | Tightly cropped browser icon |
| `mdbase-app-icon.svg` | Square application-icon source |
| `mdbase-app-icon-120.png` | Google Auth Platform branding upload |
| `mdbase-app-icon-256.png` | General small application-icon export |
| `mdbase-app-icon-512.png` | General large application-icon export |
| `mdbase-app-icon-1024.png` | High-resolution application-icon export |

The app icon is a source artifact, not a platform release bundle. Generate
platform-specific PNG, ICO, or ICNS files from it during packaging so each
target can apply its required sizes and masks.

## Source colors

- Ink: `oklch(21% 0.018 255)`, exported as `#131921`
- Accent: `oklch(45% 0.105 238)`, exported as `#005c88`
- Dark ink: `oklch(92% 0.008 255)`, exported as `#e1e5ea`
- Dark accent: `oklch(73% 0.105 238)`, exported as `#63b1e2`
- Paper: `oklch(99.5% 0.002 255)`, exported as `#fcfdff`

The hex values keep the standalone files compatible with software that does
not yet support OKLCH. Product interfaces should continue using the semantic
tokens in `packages/ui/styles.css`.

## Geometry

Do not redraw the mark by eye. Its native grid uses:

- a `76 × 76` visible square inside a `120 × 120` view box;
- one `10` unit weight;
- `8` unit horizontal gaps;
- `22` unit vertical intervals;
- `2` unit corner radii.

The first key plus its following gap equals one fence dash. The second key
equals one fence dash plus one gap. These relationships are part of the mark.
