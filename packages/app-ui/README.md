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
